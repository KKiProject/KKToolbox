export function cleanPhoneText(value, maximum = 4000) {
    return String(value ?? '').trim().slice(0, maximum);
}
