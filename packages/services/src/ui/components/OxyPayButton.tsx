import type React from 'react';
import type { ViewStyle, TextStyle, StyleProp } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';
import type { PaymentItem, PaymentGatewayResult } from '../screens/PaymentGatewayScreen';
import { LogoIcon } from './logo/LogoIcon';

export interface OxyPayButtonProps {
    style?: StyleProp<ViewStyle>;
    textStyle?: StyleProp<TextStyle>;
    text?: string;
    disabled?: boolean;
    amount: number | string;
    currency?: string;
    paymentItems?: PaymentItem[];
    description?: string;
    onPaymentResult?: (result: PaymentGatewayResult) => void;
    /**
     * Button background color. If not provided, uses variant ('white' or 'black').
     */
    color?: string;
    /**
     * Button color variant: 'white' (default) or 'black'. Ignored if color is set.
     */
    variant?: 'white' | 'black';
}

/**
 * A pre-styled button for OxyPay payments that opens the Payment Gateway
 * - Only black or white by default, but can be customized with the color prop.
 */
const OxyPayButton: React.FC<OxyPayButtonProps> = ({
    style,
    textStyle,
    text = 'Pay',
    disabled = false,
    color,
    variant = 'white',
}) => {
    const theme = useTheme();
    const handlePress = () => {
        console.warn('OxyPayButton: The bottom sheet payment flow has been removed. Provide a custom onPress handler.');
    };
    // Determine background and text color
    const backgroundColor = color || (variant === 'black' ? theme.colors.text : theme.colors.background);
    const textColor = variant === 'black' || (color && isColorDark(color)) ? theme.colors.background : '#1b1f0a';

    return (
        <Button
            variant="inverse"
            onPress={handlePress}
            disabled={disabled}
            style={[{ backgroundColor, borderColor: textColor, borderWidth: 1 }, style]}
            textStyle={[{ color: textColor, fontWeight: '700' }, textStyle]}
            icon={<LogoIcon height={16} color={textColor} style={{ marginRight: 6 }} />}
        >
            {text}
        </Button>
    );
};

// Helper to determine if a color is dark (simple luminance check)
function isColorDark(hex: string) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    if (c.length !== 6) return false;
    const r = Number.parseInt(c.substr(0, 2), 16);
    const g = Number.parseInt(c.substr(2, 2), 16);
    const b = Number.parseInt(c.substr(4, 2), 16);
    // Perceived luminance
    return (0.299 * r + 0.587 * g + 0.114 * b) < 150;
}

export default OxyPayButton;
