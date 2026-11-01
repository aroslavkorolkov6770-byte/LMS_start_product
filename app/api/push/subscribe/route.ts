import { NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/app/lib/serverAuth';
import { readDataValue, writeDataValue } from '@/app/lib/storage/dataStore';
import {
    assertRateLimit,
    assertTrustedMutationRequest,
    getClientIdentifier,
    readJsonBody,
    securityErrorResponse,
} from '@/app/lib/serverSecurity';

const PUSH_SUBSCRIPTIONS_KEY = 'tea_hub_push_subs_v1';
type UnknownRecord = Record<string, unknown>;

let pushSubscriptionWriteQueue = Promise.resolve();

const isRecord = (value: unknown): value is UnknownRecord => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const getSubscriptionPayload = (value: UnknownRecord) => {
    return isRecord(value.sub) ? value.sub : value;
};

const normalizeSubscription = (value: unknown): UnknownRecord | null => {
    if (!isRecord(value)) {
        return null;
    }

    const candidate = getSubscriptionPayload(value);
    const keys = isRecord(candidate.keys) ? candidate.keys : null;
    const endpoint = candidate.endpoint;

    if (
        typeof endpoint !== 'string'
        || !endpoint.startsWith('https://')
        || endpoint.length > 2_048
        || !keys
        || typeof keys.auth !== 'string'
        || typeof keys.p256dh !== 'string'
        || keys.auth.length > 512
        || keys.p256dh.length > 512
    ) {
        return null;
    }

    try {
        const parsedEndpoint = new URL(endpoint);
        if (parsedEndpoint.protocol !== 'https:') {
            return null;
        }
    } catch {
        return null;
    }

    return {
        endpoint,
        expirationTime: typeof candidate.expirationTime === 'number' ? candidate.expirationTime : null,
        keys: {
            auth: keys.auth,
            p256dh: keys.p256dh,
        },
    };
};

const getEndpoint = (value: UnknownRecord) => {
    const subscription = normalizeSubscription(value);
    return subscription && typeof subscription.endpoint === 'string' ? subscription.endpoint : '';
};

const withPushSubscriptionWriteLock = async <T>(operation: () => Promise<T>) => {
    const previousOperation = pushSubscriptionWriteQueue;
    let releaseOperation!: () => void;
    pushSubscriptionWriteQueue = new Promise<void>((resolve) => {
        releaseOperation = resolve;
    });

    await previousOperation;

    try {
        return await operation();
    } finally {
        releaseOperation();
    }
};

export async function POST(request: Request) {
    try {
        assertTrustedMutationRequest(request);
        const session = await getSessionFromCookies();

        if (!session) {
            return NextResponse.json({ error: 'Сессия не найдена' }, { status: 401 });
        }

        assertRateLimit('save-push-subscription', getClientIdentifier(request, session.id), 20, 5 * 60 * 1000);
        const body = await readJsonBody<{ subscription?: unknown }>(request, 16 * 1024);
        const subscription = normalizeSubscription(body.subscription);

        if (!subscription) {
            return NextResponse.json({ error: 'Некорректная подписка устройства' }, { status: 400 });
        }

        await withPushSubscriptionWriteLock(async () => {
            const existingSubscriptions = await readDataValue<UnknownRecord[]>(PUSH_SUBSCRIPTIONS_KEY, []);
            const safeExistingSubscriptions = Array.isArray(existingSubscriptions) ? existingSubscriptions : [];
            const endpoint = String(subscription.endpoint);
            const normalizedExisting = safeExistingSubscriptions.map((item) => {
                const normalized = normalizeSubscription(item);
                const userId = typeof item.userId === 'string' ? item.userId : '';

                return normalized
                    ? { userId, sub: normalized }
                    : item;
            });
            const otherUsers = normalizedExisting.filter((item) => (
                item.userId !== session.id && getEndpoint(item) !== endpoint
            ));
            const currentUserSubscriptions = normalizedExisting
                .filter((item) => item.userId === session.id && getEndpoint(item) !== endpoint)
                .slice(-9);

            await writeDataValue(PUSH_SUBSCRIPTIONS_KEY, [
                ...otherUsers,
                ...currentUserSubscriptions,
                { userId: session.id, sub: subscription },
            ]);
        });

        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        const securityResponse = securityErrorResponse(error);
        if (securityResponse) {
            return securityResponse;
        }

        console.error('Ошибка сохранения Push-подписки:', error);
        return NextResponse.json({ error: 'Не удалось привязать устройство' }, { status: 500 });
    }
}
