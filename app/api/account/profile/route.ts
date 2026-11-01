import { NextResponse } from 'next/server';
import {
    applySessionCookie,
    getCurrentStoredUser,
    getStoredUsers,
    saveStoredUsers,
    toPublicUser,
    toSessionUser,
} from '@/app/lib/serverAuth';
import { readDataValue, writeDataValue } from '@/app/lib/storage/dataStore';
import {
    assertRateLimit,
    assertTrustedMutationRequest,
    getClientIdentifier,
    readJsonBody,
    securityErrorResponse,
} from '@/app/lib/serverSecurity';

export const dynamic = 'force-dynamic';

type ProfileData = Record<string, unknown>;

export async function GET() {
    try {
        const currentUser = await getCurrentStoredUser();

        if (!currentUser) {
            return NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 });
        }

        if (currentUser.profileDisabled && !currentUser.profileOwnerOnly) {
            return NextResponse.json({ error: 'Профиль системного аккаунта скрыт' }, { status: 403 });
        }

        let profile = await readDataValue<ProfileData>(`profile_data_${currentUser.id}`, {});

        if (!profile || Array.isArray(profile) || Object.keys(profile).length === 0) {
            profile = {
                avatar: '',
                tg: currentUser.role === 'admin' ? 'admin_tea' : '',
                phone: '',
                email: currentUser.email || '',
                firstLogin: new Date().toISOString(),
            };
        }

        return NextResponse.json({
            user: toPublicUser(currentUser),
            profile,
        });
    } catch (error) {
        console.error('Ошибка чтения профиля:', error);
        return NextResponse.json({ error: 'Ошибка чтения профиля' }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    try {
        assertTrustedMutationRequest(request);
        const currentUser = await getCurrentStoredUser();

        if (!currentUser) {
            return NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 });
        }

        if (currentUser.profileDisabled && !currentUser.profileOwnerOnly) {
            return NextResponse.json({ error: 'Профиль системного аккаунта скрыт' }, { status: 403 });
        }

        assertRateLimit('account-profile', getClientIdentifier(request, currentUser.id), 30, 60 * 60 * 1000);
        const body = await readJsonBody<Record<string, unknown>>(request, 3 * 1024 * 1024);
        const name = typeof body.name === 'string' ? body.name.trim() : currentUser.name;
        const avatar = typeof body.avatar === 'string' ? body.avatar : '';
        const tg = typeof body.tg === 'string' ? body.tg : '';
        const phone = typeof body.phone === 'string' ? body.phone : '';
        const email = typeof body.email === 'string' ? body.email.trim() : '';

        if (name.length < 1 || name.length > 120 || tg.length > 120 || phone.length > 40 || email.length > 254) {
            return NextResponse.json({ error: 'Одно из полей превышает допустимую длину' }, { status: 400 });
        }

        if (avatar && !/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(avatar)) {
            return NextResponse.json({ error: 'Аватар должен быть изображением' }, { status: 400 });
        }

        const users = await getStoredUsers();
        const updatedUsers = users.map((user) => {
            if (user.id !== currentUser.id) {
                return user;
            }

            return {
                ...user,
                name,
                email,
            };
        });

        await saveStoredUsers(updatedUsers);

        const previousProfile = await readDataValue<ProfileData>(`profile_data_${currentUser.id}`, {});
        await writeDataValue(`profile_data_${currentUser.id}`, {
            ...previousProfile,
            avatar,
            tg,
            phone,
            email,
        });

        const refreshedUser = updatedUsers.find((user) => user.id === currentUser.id) || currentUser;

        const response = NextResponse.json({
            success: true,
            user: toPublicUser(refreshedUser),
            profile: {
                ...previousProfile,
                avatar,
                tg,
                phone,
                email,
            },
        });
        applySessionCookie(response, toSessionUser(refreshedUser));
        return response;
    } catch (error) {
        const securityResponse = securityErrorResponse(error);
        if (securityResponse) {
            return securityResponse;
        }

        console.error('Ошибка сохранения профиля:', error);
        return NextResponse.json({ error: 'Ошибка сохранения профиля' }, { status: 500 });
    }
}
