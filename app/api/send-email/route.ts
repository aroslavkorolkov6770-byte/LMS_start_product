import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { requireAdminSession } from '@/app/lib/serverAuth';
import {
    assertRateLimit,
    assertTrustedMutationRequest,
    escapeHtml,
    getClientIdentifier,
    readJsonBody,
    securityErrorResponse,
} from '@/app/lib/serverSecurity';

const getSmtpErrorMessage = (error: unknown) => {
    const details = error && typeof error === 'object'
        ? error as { code?: unknown; responseCode?: unknown }
        : {};
    const code = String(details.code || '');
    const responseCode = Number(details.responseCode || 0);

    if (code === 'EAUTH' || responseCode === 535) {
        return 'Почтовый сервер отклонил авторизацию. Проверьте SMTP_USER и пароль внешнего приложения Mail.ru.';
    }

    if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET') {
        return 'Почтовый сервер недоступен. Проверьте SMTP_HOST, SMTP_PORT и сетевой доступ сервера.';
    }

    return 'Не удалось отправить письмо. Проверьте настройки SMTP на сервере.';
};

export async function POST(req: Request) {
    try {
        assertTrustedMutationRequest(req);
        const session = await requireAdminSession();

        if (!session) {
            return NextResponse.json({ error: 'Доступ только для администратора' }, { status: 403 });
        }

        assertRateLimit('send-email', getClientIdentifier(req, session.id), 20, 5 * 60 * 1000);
        const body = await readJsonBody<Record<string, unknown>>(req, 64 * 1024);
        const to = typeof body.to === 'string' ? body.to.trim() : '';
        const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
        const text = typeof body.text === 'string' ? body.text.trim() : '';

        if (!to || !subject || !text) {
            return NextResponse.json({ error: 'Не все поля заполнены' }, { status: 400 });
        }

        const recipients = to.split(',').map((value) => value.trim()).filter(Boolean);
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (
            recipients.length === 0 ||
            recipients.length > 100 ||
            recipients.some((email) => email.length > 254 || !emailPattern.test(email)) ||
            subject.length > 200 ||
            /[\r\n]/.test(subject) ||
            text.length > 20_000
        ) {
            return NextResponse.json({ error: 'Параметры письма не прошли проверку' }, { status: 400 });
        }

        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
            return NextResponse.json({ error: 'Почтовый сервис не настроен' }, { status: 503 });
        }

        const smtpPort = Number.parseInt(process.env.SMTP_PORT || '465', 10);
        const smtpSecure = process.env.SMTP_SECURE !== 'false';

        if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535) {
            return NextResponse.json({ error: 'Неверно настроен SMTP-порт' }, { status: 503 });
        }

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.mail.ru',
            port: smtpPort,
            secure: smtpSecure,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
            connectionTimeout: 10000,
            greetingTimeout: 5000,
            socketTimeout: 15000,
            logger: false,
            debug: false,
            disableFileAccess: true,
            disableUrlAccess: true,
        });

        const safeText = escapeHtml(text).replace(/\r?\n/g, '<br>');
        await transporter.sendMail({
            from: `"Ватэс" <${process.env.SMTP_USER}>`,
            to: recipients,
            subject,
            text,
            html: `
                <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
                    <h2 style="color: #2e7d78;">Ватэс: уведомление</h2>
                    <p>${safeText}</p>
                    <br>
                    <hr style="border: 0; border-top: 1px solid #eee;">
                    <p style="font-size: 12px; color: #888;">Это автоматическое сообщение. Пожалуйста, не отвечайте на него.</p>
                </div>
            `,
            headers: {
                'X-Priority': '3',
                'X-Mailer': 'TeaHub-LMS-System',
            },
            disableFileAccess: true,
            disableUrlAccess: true,
        });

        return NextResponse.json({ success: true });
        
    } catch (error: unknown) {
        const securityResponse = securityErrorResponse(error);
        if (securityResponse) {
            return securityResponse;
        }

        console.error('Ошибка отправки email:', error);
        return NextResponse.json({ error: getSmtpErrorMessage(error) }, { status: 502 });
    }
}
