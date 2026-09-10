import type { PaymentMethod } from './types';

export const PAYMENT_METHODS: PaymentMethod[] = [
    { key: 'card', label: 'Credit/Debit Card', icon: 'card-outline', description: 'Pay securely with your credit or debit card.' },
    { key: 'oxy', label: 'Peable', icon: 'wallet-outline', description: 'Use your Peable in-app balance.' },
    { key: 'faircoin', label: 'FAIRWallet', icon: 'qr-code-outline', description: 'Pay with FairCoin by scanning a QR code.' },
];

export const CURRENCY_SYMBOLS: Record<string, string> = {
    FAIR: '⊜',
    INR: '₹',
    USD: '$',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    CNY: '¥',
    AUD: 'A$',
    CAD: 'C$',
};

export const CURRENCY_NAMES: Record<string, string> = {
    FAIR: 'FairCoin',
    INR: 'Indian Rupee',
    USD: 'US Dollar',
    EUR: 'Euro',
    GBP: 'British Pound',
    JPY: 'Japanese Yen',
    CNY: 'Chinese Yuan',
    AUD: 'Australian Dollar',
    CAD: 'Canadian Dollar',
};

export const getCurrencySymbol = (currency: string): string => {
    return CURRENCY_SYMBOLS[currency.toUpperCase()] || currency;
};

export const getCurrencyName = (currency: string): string => {
    return CURRENCY_NAMES[currency.toUpperCase()] || currency;
};
