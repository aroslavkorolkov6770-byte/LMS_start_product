import { NextResponse } from 'next/server';
import dns from 'dns/promises';
import {
    applySessionCookie,
    getStoredUsers,
    normalizeStoredPassword,
    saveStoredUsers,
    toPublicUser,
    toSessionUser,
    verifyPassword,
} from '@/app/lib/serverAuth';
import { writeDataValue } from '@/app/lib/storage/dataStore';
import {
    assertRateLimit,
    assertTrustedMutationRequest,
    getClientIdentifier,
    readJsonBody,
    securityErrorResponse,
} from '@/app/lib/serverSecurity';

export const dynamic = 'force-dynamic';

const normalizePhoneNumber = (phone: string) => phone.replace(/\D/g, '');

const isValidPhoneNumber = (phone: string) => {
    const normalizedPhone = normalizePhoneNumber(phone);
    return normalizedPhone.length >= 10 && normalizedPhone.length <= 15;
};

const hasWorkingMailDomain = async (email: string) => {
    const domain = email.split('@')[1]?.toLowerCase();

    if (!domain) {
        return false;
    }

    try {
        const mxRecords = await dns.resolveMx(domain);
        if (Array.isArray(mxRecords) && mxRecords.length > 0) {
            return true;
        }
    } catch (error) {
        console.warn(`MX-проверка не прошла для ${domain}:`, error);
    }

    try {
        const ipv4Records = await dns.resolve4(domain);
        if (Array.isArray(ipv4Records) && ipv4Records.length > 0) {
            return true;
        }
    } catch (error) {
        console.warn(`A-проверка не прошла для ${domain}:`, error);
    }

    try {
        const ipv6Records = await dns.resolve6(domain);
        if (Array.isArray(ipv6Records) && ipv6Records.length > 0) {
            return true;
        }
    } catch (error) {
        console.warn(`AAAA-проверка не прошла для ${domain}:`, error);
    }

    return false;
};

export async function POST(request: Request) {
    try {
        assertTrustedMutationRequest(request);
        assertRateLimit('auth-register', getClientIdentifier(request), 8, 60 * 60 * 1000);

        const body = await readJsonBody<Record<string, unknown>>(request, 16 * 1024);

        const login = typeof body.login === 'string' ? body.login.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const tg = typeof body.tg === 'string' ? body.tg.trim() : '';
        const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
        const consentGiven = body.consentGiven === true;

        if (!consentGiven) {
            return NextResponse.json({ error: 'Требуется согласие на обработку данных' }, { status: 400 });
        }

        if (!login || !password || !name || !email || !tg || !phone) {
            return NextResponse.json({ error: 'Нужно заполнить все поля' }, { status: 400 });
        }

        if (
            login.length > 120 ||
            password.length > 128 ||
            name.length > 120 ||
            email.length > 254 ||
            tg.length > 120 ||
            phone.length > 40
        ) {
            return NextResponse.json({ error: 'Одно из полей превышает допустимую длину' }, { status: 400 });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return NextResponse.json({ error: 'Неверный формат E-mail' }, { status: 400 });
        }

        if (!(await hasWorkingMailDomain(email))) {
            return NextResponse.json({ error: 'Указанный E-mail домен не отвечает. Проверьте адрес почты.' }, { status: 400 });
        }

        if (!isValidPhoneNumber(phone)) {
            return NextResponse.json({ error: 'Номер телефона должен содержать от 10 до 15 цифр.' }, { status: 400 });
        }

        const normalizedPhone = normalizePhoneNumber(phone);
        const users = await getStoredUsers();
        const foundUserIndex = users.findIndex((user) => user.login === login && verifyPassword(user, password));

        if (foundUserIndex === -1) {
            return NextResponse.json(
                { error: 'Учетная запись с такими данными не найдена. Проверьте логин и пароль, выданные администратором.' },
                { status: 404 },
            );
        }

        const updatedUser = normalizeStoredPassword(
            {
                ...users[foundUserIndex],
                name,
                email,
                isRegistered: true,
            },
            password,
        );

        const updatedUsers = [...users];
        updatedUsers[foundUserIndex] = updatedUser;
        await saveStoredUsers(updatedUsers);

        await writeDataValue(`profile_data_${updatedUser.id}`, {
            avatar: '',
            tg,
            phone: normalizedPhone,
            email,
            name,
            firstLogin: new Date().toISOString(),
        });

        const response = NextResponse.json({
            success: true,
            user: toPublicUser(updatedUser),
        });

        applySessionCookie(response, toSessionUser(updatedUser));
        return response;
    } catch (error) {
        const securityResponse = securityErrorResponse(error);
        if (securityResponse) {
            return securityResponse;
        }

        console.error('Ошибка регистрации:', error);
        return NextResponse.json({ error: 'Ошибка сервера при регистрации' }, { status: 500 });
    }
}
