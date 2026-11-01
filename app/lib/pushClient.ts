'use client';

export type WebPushSupport = {
    supported: boolean;
    message?: string;
};

export type WebPushRegistrationResult = {
    success: boolean;
    message: string;
};

const isIosDevice = () => {
    if (typeof navigator === 'undefined') {
        return false;
    }

    const userAgent = navigator.userAgent;
    const isAppleMobile = /iPad|iPhone|iPod/i.test(userAgent);
    const isTouchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    return isAppleMobile || isTouchMac;
};

const getIosVersion = () => {
    if (typeof navigator === 'undefined') {
        return null;
    }

    const match = navigator.userAgent.match(/OS (\d+)[._](\d+)(?:[._](\d+))?/i);
    if (!match) {
        return null;
    }

    return [Number(match[1]), Number(match[2]), Number(match[3] || 0)] as const;
};

const isIosVersionAtLeast = (version: readonly number[], required: readonly number[]) => {
    for (let index = 0; index < required.length; index += 1) {
        const current = version[index] || 0;
        const minimum = required[index] || 0;
        if (current > minimum) return true;
        if (current < minimum) return false;
    }

    return true;
};

const isStandaloneDisplayMode = () => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
        return false;
    }

    const legacyStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return legacyStandalone || window.matchMedia('(display-mode: standalone)').matches;
};

export const getWebPushSupport = (): WebPushSupport => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
        return { supported: false, message: 'Web Push доступен только в браузере.' };
    }

    if (!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        return { supported: false, message: 'Для Web Push нужен защищенный адрес HTTPS.' };
    }

    if (isIosDevice()) {
        const iosVersion = getIosVersion();
        if (iosVersion && !isIosVersionAtLeast(iosVersion, [16, 4])) {
            return { supported: false, message: 'На iPhone Web Push доступен начиная с iOS 16.4.' };
        }

        if (!isStandaloneDisplayMode()) {
            return {
                supported: false,
                message: 'На iPhone откройте сайт в Safari, нажмите «Поделиться» → «На экран Домой», затем запускайте его с этого значка.',
            };
        }
    }

    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        return { supported: false, message: 'Этот браузер не поддерживает Web Push уведомления.' };
    }

    return { supported: true };
};

const urlBase64ToUint8Array = (value: string) => {
    const cleanValue = value.replace(/["']/g, '').trim();
    const padding = '='.repeat((4 - (cleanValue.length % 4)) % 4);
    const base64 = `${cleanValue}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let index = 0; index < rawData.length; index += 1) {
        outputArray[index] = rawData.charCodeAt(index);
    }

    return outputArray;
};

const getPushErrorMessage = (error: unknown) => {
    if (error instanceof Error && error.message) {
        return error.message;
    }

    return 'Не удалось зарегистрировать устройство. Проверьте разрешение уведомлений и попробуйте еще раз.';
};

export const getPushBindingStorageKey = (userId: string) => `tea_hub_push_bound_${userId}`;

export const registerWebPushForUser = async (userId: string): Promise<WebPushRegistrationResult> => {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId || normalizedUserId === 'guest') {
        return { success: false, message: 'Сначала войдите в свой аккаунт.' };
    }

    const support = getWebPushSupport();
    if (!support.supported) {
        return { success: false, message: support.message || 'Web Push недоступен на этом устройстве.' };
    }

    try {
        if (Notification.permission === 'denied') {
            return { success: false, message: 'Уведомления запрещены в настройках браузера. Разрешите их для этого сайта и повторите попытку.' };
        }

        const permission = Notification.permission === 'granted'
            ? 'granted'
            : await Notification.requestPermission();

        if (permission !== 'granted') {
            return { success: false, message: 'Разрешение на уведомления не выдано.' };
        }

        const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
        if (!vapidPublicKey) {
            return { success: false, message: 'На сервере не настроен открытый VAPID-ключ. Обратитесь к администратору.' };
        }

        const registration = await navigator.serviceWorker.register('/sw.js', {
            scope: '/',
            updateViaCache: 'none',
        });
        await registration.update().catch(() => undefined);
        const readyRegistration = await navigator.serviceWorker.ready;
        let subscription = await readyRegistration.pushManager.getSubscription();

        // Переподписываем устройство, чтобы ключи старой версии не ломали доставку.
        if (subscription) {
            await subscription.unsubscribe();
            subscription = null;
        }

        subscription = await readyRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        });

        const subscriptionPayload = subscription.toJSON();
        const saveSubscriptionResponse = await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ subscription: subscriptionPayload }),
        });

        const saveSubscriptionResult = await saveSubscriptionResponse.json().catch(() => ({}));
        if (!saveSubscriptionResponse.ok) {
            throw new Error(saveSubscriptionResult?.error || `Сервер не сохранил подписку (${saveSubscriptionResponse.status}).`);
        }

        if (!saveSubscriptionResult?.success) {
            await subscription.unsubscribe().catch(() => false);
            throw new Error('Сервер не подтвердил регистрацию устройства.');
        }

        localStorage.setItem('tea_hub_push_bound', 'true');
        localStorage.setItem(getPushBindingStorageKey(normalizedUserId), 'true');

        return {
            success: true,
            message: 'Устройство зарегистрировано и привязано к вашему аккаунту.',
        };
    } catch (error) {
        console.error('Ошибка регистрации Web Push:', error);
        return { success: false, message: getPushErrorMessage(error) };
    }
};
