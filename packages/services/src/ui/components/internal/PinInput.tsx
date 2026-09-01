import React, { useRef, forwardRef, useImperativeHandle } from 'react';
import { View, TextInput, StyleSheet, Platform, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';

interface PinInputColors {
    primary: string;
    secondary?: string;
    background: string;
    inputBackground: string;
    text: string;
    border: string;
}

export interface PinInputProps {
    value: string;
    onChange: (val: string) => void;
    length?: number;
    disabled?: boolean;
    autoFocus?: boolean;
    colors: PinInputColors;
}

export interface PinInputHandle {
    focus: () => void;
}

const PinInput = forwardRef<PinInputHandle, PinInputProps>(({ value, onChange, length = 6, disabled, autoFocus, colors }, ref) => {
    const theme = useTheme();
    const inputs = useRef<Array<TextInput | null>>([]);

    useImperativeHandle(ref, () => ({
        focus: () => {
            inputs.current[0]?.focus();
        }
    }), []);

    const handleChange = (text: string, idx: number) => {
        if (!/^[0-9]*$/.test(text)) return;
        let newValue = value.split('');
        if (text.length > 1) {
            // Paste or autofill
            newValue = text.split('').slice(0, length);
            onChange(newValue.join(''));
            if (newValue.length < length) {
                inputs.current[newValue.length]?.focus();
            }
            return;
        }
        newValue[idx] = text;
        const joined = newValue.join('').slice(0, length);
        onChange(joined);
        if (text && idx < length - 1) {
            inputs.current[idx + 1]?.focus();
        }
    };

    const handleKeyPress = (e: NativeSyntheticEvent<TextInputKeyPressEventData>, idx: number) => {
        if (e.nativeEvent.key === 'Backspace' && !value[idx] && idx > 0) {
            inputs.current[idx - 1]?.focus();
        }
    };

    return (
        <View style={styles.pinContainer}>
            {Array.from({ length }).map((_, idx) => (
                <TextInput
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed-position PIN cells, order never changes
                    key={`pin-input-${idx}`}
                    ref={(ref) => { inputs.current[idx] = ref; }}
                    style={[
                        styles.pinInput,
                        { borderColor: colors.primary, color: colors.text, backgroundColor: colors.inputBackground || theme.colors.backgroundSecondary },
                        value[idx] ? { borderWidth: 2 } : { borderWidth: 1 },
                    ]}
                    value={value[idx] || ''}
                    onChangeText={text => handleChange(text, idx)}
                    onKeyPress={e => handleKeyPress(e, idx)}
                    keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
                    maxLength={1}
                    editable={!disabled}
                    autoFocus={autoFocus && idx === 0}
                    textAlign="center"
                    selectionColor={colors.primary}
                    returnKeyType="done"
                />
            ))}
        </View>
    );
});

const styles = StyleSheet.create({
    pinContainer: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 12,
        marginBottom: 0,
        marginTop: 0,
    },
    pinInput: {
        width: 44,
        height: 54,
        borderRadius: 12,
        borderWidth: 1,
        fontSize: 28,
        fontWeight: '600',
        textAlign: 'center',
        marginHorizontal: 2,
        ...Platform.select({
            web: {
                boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
            },
            default: {
                shadowColor: '#000',
                shadowOpacity: 0.04,
                shadowOffset: { width: 0, height: 1 },
                shadowRadius: 4,
                elevation: 1,
            }
        }),
    },
});

export default PinInput;
