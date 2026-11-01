// Невидимый пробел сохраняет место для реквизитов, пока компания не зарегистрирована.
export const INVISIBLE_COMPANY_PLACEHOLDER = '\u200B';

// После регистрации замените значения здесь: футер, шапка и политики обновятся вместе.
// Адрес сайта указывается полностью, например с https://, без завершающего слеша.
export const COMPANY_DETAILS = {
    name: INVISIBLE_COMPANY_PLACEHOLDER,
    websiteUrl: INVISIBLE_COMPANY_PLACEHOLDER,
    supportEmail: INVISIBLE_COMPANY_PLACEHOLDER,
};

export const hasCompanyDetail = (value: string) => {
    return value.replace(/[\u200B\uFEFF]/g, '').trim().length > 0;
};

// Пока адрес не заполнен, в политике не появятся ни старый домен, ни обрывок ссылки.
export const getCompanyWebsiteUrl = (path = '') => {
    if (!hasCompanyDetail(COMPANY_DETAILS.websiteUrl)) {
        return INVISIBLE_COMPANY_PLACEHOLDER;
    }

    return `${COMPANY_DETAILS.websiteUrl.replace(/\/+$/, '')}${path}`;
};
