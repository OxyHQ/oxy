/**
 * Front face of the Oxy ID card — laid out like a real vertical ID / passport
 * data page: an issuer header, a framed portrait beside the primary name, a
 * column of labelled fields, and a machine-readable zone (MRZ) at the bottom.
 * The content is printed FLAT on the card (no parallax float) so it reads as an
 * engraved document over the hologram, not UI floating on top.
 */

import { useMemo } from 'react';
import { StyleSheet, Text, View, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Fonts } from '@/constants/theme';
import { HolographicLogo } from './holographic-logo';
import { AVATAR_ELEVATION, ParallaxLayer, TEXT_ELEVATION } from './tilt-context';

interface FrontSideProps {
    displayName?: string;
    username?: string;
    avatarUrl?: string;
    accountCreated?: string;
    publicKeyShort?: string;
}

// Reduce a value to the MRZ alphabet (A–Z, 0–9, filler '<'), collapse runs of
// filler, and pad/truncate to a fixed width — passport-style.
const sanitizeMrz = (value: string | undefined, length: number) =>
    (value ?? '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '<')
        .replace(/<{2,}/g, '<')
        .padEnd(length, '<')
        .slice(0, length);

// Kept short enough that the MRZ lines clear the Commons emblem watermark in the
// card's bottom-right corner (rendered in the hologram layer behind this).
const MRZ_WIDTH = 22;

export const FrontSide: React.FC<FrontSideProps> = ({
    displayName,
    username,
    avatarUrl,
    accountCreated,
    publicKeyShort,
}) => {
    const mrzLines = useMemo(() => {
        const name = sanitizeMrz(username ?? displayName, MRZ_WIDTH - 5);
        const line1 = `IDOXY${name}`.padEnd(MRZ_WIDTH, '<').slice(0, MRZ_WIDTH);
        const line2 = sanitizeMrz(publicKeyShort, MRZ_WIDTH);
        return [line1, line2];
    }, [username, displayName, publicKeyShort]);

    const issued = useMemo(() => {
        if (!accountCreated) return undefined;
        const d = new Date(accountCreated);
        if (Number.isNaN(d.getTime())) return undefined;
        const yy = String(d.getFullYear()).slice(2);
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${dd}.${mm}.${yy}`;
    }, [accountCreated]);

    return (
        <View style={styles.container}>
            {/* Issuer header */}
            <View style={styles.header}>
                <HolographicLogo size={22} />
                <Text style={styles.docType}>IDENTITY CARD</Text>
            </View>

            {/* Portrait + primary name */}
            <ParallaxLayer elevation={AVATAR_ELEVATION} style={styles.identityRow}>
                <View style={styles.avatarContainer}>
                    {avatarUrl ? (
                        <Image source={{ uri: avatarUrl }} style={styles.avatar} resizeMode="cover" />
                    ) : (
                        <View style={styles.avatarPlaceholder}>
                            <Text style={styles.avatarPlaceholderText}>
                                {displayName?.charAt(0)?.toUpperCase() || '?'}
                            </Text>
                        </View>
                    )}
                    {avatarUrl && (
                        <>
                            <LinearGradient
                                colors={['rgba(0,0,0,0.18)', 'rgba(0,0,0,0)']}
                                start={{ x: 0.5, y: 1 }}
                                end={{ x: 0.5, y: 0.4 }}
                                style={styles.avatarShade}
                            />
                        </>
                    )}
                </View>
                <View style={styles.primaryCol}>
                    <Text style={styles.fieldLabel}>NAME</Text>
                    <Text style={styles.primaryValue} numberOfLines={2}>
                        {displayName || (username ? `@${username}` : publicKeyShort) || '—'}
                    </Text>
                    <Text style={styles.fieldLabel}>TYPE</Text>
                    <Text style={styles.fieldValueSmall}>SELF-CUSTODY</Text>
                </View>
            </ParallaxLayer>

            {/* Labelled fields */}
            <ParallaxLayer elevation={TEXT_ELEVATION} style={styles.fields}>
                {username && (
                    <View style={styles.field}>
                        <Text style={styles.fieldLabel}>USERNAME</Text>
                        <Text style={styles.fieldValueSmall} numberOfLines={1}>
                            {username}
                        </Text>
                    </View>
                )}
                <View style={styles.field}>
                    <Text style={styles.fieldLabel}>ID NUMBER</Text>
                    <Text style={styles.idNumber} numberOfLines={1}>
                        {publicKeyShort || 'N/A'}
                    </Text>
                </View>
                {issued && (
                    <View style={styles.field}>
                        <Text style={styles.fieldLabel}>ISSUED</Text>
                        <Text style={styles.fieldValueSmall}>{issued}</Text>
                    </View>
                )}
            </ParallaxLayer>

            {/* Machine-readable zone */}
            <ParallaxLayer elevation={TEXT_ELEVATION} style={styles.mrz}>
                <Text style={styles.mrzLine} numberOfLines={1}>
                    {mrzLines[0]}
                </Text>
                <Text style={styles.mrzLine} numberOfLines={1}>
                    {mrzLines[1]}
                </Text>
            </ParallaxLayer>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 18,
        justifyContent: 'space-between',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(0,0,0,0.18)',
        paddingBottom: 6,
    },
    docType: {
        fontSize: 9,
        fontWeight: '600',
        letterSpacing: 1.2,
        color: '#6E6E73',
    },
    identityRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
    },
    avatarContainer: {
        width: 84,
        height: 104,
        borderRadius: 6,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'rgba(0,0,0,0.2)',
        backgroundColor: 'rgba(255,255,255,0.35)',
    },
    avatar: {
        width: '100%',
        height: '100%',
    },
    avatarShade: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: '45%',
    },
    avatarPlaceholder: {
        width: '100%',
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatarPlaceholderText: {
        fontSize: 40,
        fontWeight: '600',
        color: 'rgba(28,28,30,0.5)',
    },
    primaryCol: {
        flex: 1,
        justifyContent: 'flex-start',
    },
    fields: {
        gap: 8,
    },
    field: {
        gap: 1,
    },
    fieldLabel: {
        color: '#6E6E73',
        fontSize: 8.5,
        letterSpacing: 0.7,
        textTransform: 'uppercase',
        fontWeight: '600',
        marginTop: 4,
    },
    primaryValue: {
        color: '#1C1C1E',
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
        lineHeight: 20,
    },
    fieldValueSmall: {
        color: '#1C1C1E',
        fontSize: 13,
        fontWeight: '500',
    },
    idNumber: {
        color: '#1C1C1E',
        fontFamily: Fonts?.mono,
        fontSize: 12,
        fontWeight: '600',
        letterSpacing: 0.6,
    },
    mrz: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: 'rgba(0,0,0,0.18)',
        paddingTop: 8,
        gap: 2,
    },
    mrzLine: {
        fontFamily: Fonts?.mono,
        fontSize: 9.5,
        letterSpacing: 1,
        color: '#2B2B2E',
    },
});
