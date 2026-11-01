import { NextResponse } from 'next/server';
import { getLoginValidationError } from '@/app/lib/loginValidation';
import {
    applySessionCookie,
    getStoredUsers,
    isHiddenSystemUser,
    normalizeStoredPassword,
    requireAdminSession,
    saveStoredUsers,
    toPublicUser,
    toSessionUser,
} from '@/app/lib/serverAuth';
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
        const session = await requireAdminSession();

        if (!session) {
            return NextResponse.json({ error: 'Доступ только для администратора' }, { status: 403 });
        }

        assertRateLimit('admin-user-credentials', getClientIdentifier(request, session.id), 30, 60 * 60 * 1000);
        const body = await readJsonBody<Record<string, unknown>>(request, 8 * 1024);
        const userId = typeof body.userId === 'string' ? body.userId : '';
        const login = typeof body.login === 'string' ? body.login.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';

        const validationError = getLoginValidationError(login);
        if (!userId || validationError) {
            return NextResponse.json({ error: validationError || 'Укажите сотрудника' }, { status: 400 });
        }

        if ((body.password !== undefined && typeof body.password !== 'string') || (password && (password.length < 8 || password.length > 128))) {
            return NextResponse.json({ error: 'Новый пароль должен содержать от 8 до 128 символов' }, { status: 400 });
        }

        const users = await getStoredUsers();
        const targetUser = users.find((user) => user.id === userId);

        if (!targetUser) {
            return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });
        }

        if (isHiddenSystemUser(targetUser) && session.id !== userId) {
            return NextResponse.json({ error: 'Доступ к системному аккаунту закрыт' }, { status: 403 });
        }

        if (users.some((user) => user.login === login && user.id !== userId)) {
            return NextResponse.json({ error: 'Логин уже занят другим пользователем' }, { status: 409 });
        }

        // Без нового пароля сохраняем существующий хеш. Старый совместный сценарий логин+пароль остаётся доступным.
        const loginChanged = targetUser.login !== login;
        const updatedUser = password ? normalizeStoredPassword({ ...targetUser, login }, password) : {
            ...targetUser,
            login,
            authVersion: (targetUser.authVersion || 0) + (loginChanged ? 1 : 0),
        };
        if (loginChanged || password) {
            await saveStoredUsers(users.map((user) => user.id === userId ? updatedUser : user));
        }

        const response = NextResponse.json({
            success: true,
            user: toPublicUser(updatedUser),
        });
        if (session.id === userId) {
            applySessionCookie(response, toSessionUser(updatedUser));
        }
        return response;
    } catch (error) {
        const securityResponse = securityErrorResponse(error);
        if (securityResponse) {
            return securityResponse;
        }

        console.error('Ошибка обновления доступов:', error);
        return NextResponse.json({ error: 'Ошибка обновления доступов' }, { status: 500 });
    }
}
