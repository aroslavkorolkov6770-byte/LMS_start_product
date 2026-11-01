import { NextResponse } from 'next/server';
import {
    applySessionCookie,
    getCurrentStoredUser,
    getStoredUsers,
    saveStoredUsers,
    toPublicUser,
    toSessionUser,
    verifyPassword,
} from '@/app/lib/serverAuth';
import { getLoginValidationError } from '@/app/lib/loginValidation';
import {
    assertRateLimit,
    assertTrustedMutationRequest,
    getClientIdentifier,
    readJsonBody,
    securityErrorResponse,
} from '@/app/lib/serverSecurity';

export const dynamic = 'force-dynamic';

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

        assertRateLimit('account-login', getClientIdentifier(request, currentUser.id), 10, 60 * 60 * 1000);
        const body = await readJsonBody<{ login?: unknown; currentPassword?: unknown }>(request, 8 * 1024);
        const login = typeof body.login === 'string' ? body.login.trim() : '';
        const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
        const validationError = getLoginValidationError(login);
        if (validationError || !currentPassword || currentPassword.length > 128) {
            return NextResponse.json({ error: validationError || 'Укажите текущий пароль' }, { status: 400 });
        }

        const users = await getStoredUsers();
        const storedUser = users.find((user) => user.id === currentUser.id);
        if (!storedUser || !verifyPassword(storedUser, currentPassword)) {
            return NextResponse.json({ error: 'Неверный текущий пароль' }, { status: 401 });
        }

        if (users.some((user) => user.id !== storedUser.id && user.login === login)) {
            return NextResponse.json({ error: 'Логин уже занят другим пользователем' }, { status: 409 });
        }

        // Меняется только логин. ID, пароль, профиль и привязанный к ID учебный прогресс сохраняются.
        // При настоящем изменении отзываем прежние сессии; повторное сохранение того же логина их не затрагивает.
        const updatedUser = login === storedUser.login ? storedUser : {
            ...storedUser,
            login,
            authVersion: (storedUser.authVersion || 0) + 1,
        };
        if (updatedUser !== storedUser) {
            await saveStoredUsers(users.map((user) => user.id === storedUser.id ? updatedUser : user));
        }

        const response = NextResponse.json({ success: true, user: toPublicUser(updatedUser) });
        applySessionCookie(response, toSessionUser(updatedUser));
        return response;
    } catch (error) {
        const securityResponse = securityErrorResponse(error);
        if (securityResponse) return securityResponse;
        console.error('Ошибка смены логина:', error);
        return NextResponse.json({ error: 'Не удалось изменить логин' }, { status: 500 });
    }
}
