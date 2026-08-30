import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, Platform, Animated } from 'react-native';
import type { BaseScreenProps } from '../types/navigation';
import { Avatar } from '@oxyhq/bloom/avatar';
import Ionicons from '../icons/Ionicons';
import { toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { Button } from '@oxyhq/bloom/button';
import { H1, Text } from '@oxyhq/bloom/typography';
import { TextField, TextFieldInput } from '@oxyhq/bloom/text-field';
import { useI18n } from '../hooks/useI18n';
import { useSurfaceHeader } from '../hooks/useSurfaceHeader';
import { useOxy } from '../context/OxyContext';
import { useUpdateProfile } from '../hooks/mutations/useAccountMutations';
import { getNormalizedUserHandle, type User } from '@oxyhq/core';

const GAP = 12;
const INNER_GAP = 8;

/**
 * Post-signup welcome & onboarding screen.
 * - Greets the newly registered user
 * - Lets them immediately set / change their avatar using existing FileManagement picker
 * - Only when the user presses "Continue" do we invoke onAuthenticated to finish flow & close sheet
 */
const WelcomeNewUserScreen: React.FC<BaseScreenProps & { newUser?: User }> = ({
    onAuthenticated,
    theme,
    newUser,
}) => {
    // Use useOxy() hook for OxyContext values. The greeting/avatar identity is
    // the ACTIVE account (the personal user during onboarding, but read through
    // `user` so this stays correct everywhere), with the freshly
    // registered `newUser` as the pre-store-hydration fallback.
    const { user, oxyServices, openAvatarPicker: openChangeAvatarSurface } = useOxy();
    const { t, locale } = useI18n();
    const updateProfileMutation = useUpdateProfile();
    const currentUser = user || newUser; // fallback
    const bloomTheme = useTheme();
    const colors = {
        primary: bloomTheme.colors.primary,
        border: bloomTheme.colors.border,
        text: bloomTheme.colors.text,
    };
    const styles = useMemo(() => createStyles(), []);

    // Animation state
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const slideAnim = useRef(new Animated.Value(0)).current;
    const [currentStep, setCurrentStep] = useState(0);
    // Name form state for the conditional "set your name" step. Lazy initializers
    // seed from the current user once; no useEffect prop→state sync.
    const [firstName, setFirstName] = useState(() => (currentUser?.name?.first ?? '').trim());
    const [lastName, setLastName] = useState(() => (currentUser?.name?.last ?? '').trim());
    const [savingName, setSavingName] = useState(false);

    // Derived, not mirrored: `openAvatarPicker` writes through the shared avatar
    // path, which updates the active account — including CLEARING it when the
    // user removes their photo, which a "last non-empty value" mirror could not
    // represent.
    const avatarUri = currentUser?.avatar
        ? oxyServices.getFileDownloadUrl(currentUser.avatar, 'thumb')
        : undefined;

    // API DTO contract: explicit displayName, else the normalized handle.
    const welcomeName =
        currentUser?.name?.displayName ?? getNormalizedUserHandle(currentUser) ?? '';
    const welcomeTitle = currentUser && welcomeName
        ? (t('welcomeNew.welcome.titleWithName', { username: welcomeName }) || `Welcome, ${welcomeName} 👋`)
        : (t('welcomeNew.welcome.title') || 'Welcome 👋');
    // Only ask the user for their name during onboarding when they don't have a
    // first name yet. publicKey-only / minimal accounts surface this step.
    const needsName = !!currentUser && !(currentUser.name?.first ?? '').trim();
    const steps: Array<{ key: string; title: string; bullets?: string[]; body?: string; showAvatar?: boolean; showNameForm?: boolean; }> = [
        { key: 'welcome', title: welcomeTitle, body: t('welcomeNew.welcome.body') || "You just created an account in a calm, ethical space. A few quick things — then you're in." },
        {
            key: 'account', title: t('welcomeNew.account.title') || 'One Account. Simple.', bullets: [
                t('welcomeNew.account.bullets.0') || 'One identity across everything',
                t('welcomeNew.account.bullets.1') || 'No re‑signing in all the time',
                t('welcomeNew.account.bullets.2') || 'Your preferences stay with you',
            ]
        },
        {
            key: 'principles', title: t('welcomeNew.principles.title') || 'What We Stand For', bullets: [
                t('welcomeNew.principles.bullets.0') || 'Privacy by default',
                t('welcomeNew.principles.bullets.1') || 'No manipulative feeds',
                t('welcomeNew.principles.bullets.2') || 'You decide what to share',
                t('welcomeNew.principles.bullets.3') || 'No selling your data',
            ]
        },
        { key: 'trust', title: t('welcomeNew.trust.title') || 'Oxy Trust = Trust & Growth', body: t('welcomeNew.trust.body') || 'Oxy Trust is a reputation system that reacts to what you do. Helpful, respectful, constructive actions earn reputation. Harmful or low‑effort stuff chips it away. More reputation raises your trust tier and can unlock benefits; low reputation can limit features. It keeps things fair and rewards real contribution.' },
        { key: 'avatar', title: t('welcomeNew.avatar.title') || 'Make It Yours', body: t('welcomeNew.avatar.body') || 'Add an avatar so people recognize you. It will show anywhere you show up here. Skip if you want — you can add it later.', showAvatar: true },
        { key: 'ready', title: t('welcomeNew.ready.title') || "You're Ready", body: t('welcomeNew.ready.body') || 'Explore. Contribute. Earn reputation. Stay in control.' }
    ];
    if (needsName) {
        // Inject the required name step immediately BEFORE the avatar step:
        // …trust, name, avatar, ready.
        const insertAt = steps.findIndex(s => s.showAvatar);
        const nameStep = {
            key: 'name',
            title: t('welcomeNew.name.title') || "What's your name?",
            body: t('welcomeNew.name.body') || 'Add your name so people know who you are.',
            showNameForm: true,
        };
        if (insertAt >= 0) {
            steps.splice(insertAt, 0, nameStep);
        } else {
            steps.push(nameStep);
        }
    }
    const totalSteps = steps.length;
    const avatarStepIndex = steps.findIndex(s => s.showAvatar);
    const nameStepIndex = steps.findIndex(s => s.showNameForm);

    const animateToStepCallback = useCallback((next: number) => {
        Animated.timing(fadeAnim, { toValue: 0, duration: 180, useNativeDriver: Platform.OS !== 'web' }).start(() => {
            setCurrentStep(next);
            slideAnim.setValue(-40);
            Animated.parallel([
                Animated.timing(fadeAnim, { toValue: 1, duration: 220, useNativeDriver: Platform.OS !== 'web' }),
                Animated.spring(slideAnim, { toValue: 0, useNativeDriver: Platform.OS !== 'web', friction: 9 })
            ]).start();
        });
    }, [fadeAnim, slideAnim]);

    const nextStep = useCallback(() => { if (currentStep < totalSteps - 1) animateToStepCallback(currentStep + 1); }, [currentStep, totalSteps, animateToStepCallback]);
    const prevStep = useCallback(() => { if (currentStep > 0) animateToStepCallback(currentStep - 1); }, [currentStep, animateToStepCallback]);
    // Skip from the intro step lands on the FIRST personalization step that
    // exists — the required name step when present, otherwise the avatar step —
    // so the required name step can never be bypassed.
    const skipToAvatar = useCallback(() => {
        const personalizeIndex = nameStepIndex >= 0 ? nameStepIndex : avatarStepIndex;
        if (personalizeIndex >= 0) animateToStepCallback(personalizeIndex);
    }, [nameStepIndex, avatarStepIndex, animateToStepCallback]);
    const finish = useCallback(() => { if (onAuthenticated && currentUser) onAuthenticated(currentUser); }, [onAuthenticated, currentUser]);
    const submitName = useCallback(async () => {
        const f = firstName.trim();
        if (!f) return;
        setSavingName(true);
        try {
            await updateProfileMutation.mutateAsync({ name: { first: f, last: lastName.trim() } });
            animateToStepCallback(currentStep + 1);
        } catch (e: unknown) {
            toast.error((e instanceof Error ? e.message : null) || t('welcomeNew.name.saveFailed') || 'Could not save your name');
        } finally {
            setSavingName(false);
        }
    }, [firstName, lastName, updateProfileMutation, animateToStepCallback, currentStep, t]);
    /**
     * Onboarding uses the SAME avatar flow as everywhere else — the ChangeAvatar
     * surface (source list → crop → upload). It used to run its own
     * pick-a-file-and-set-it path, which bypassed the cropper entirely.
     */
    const openAvatarPicker = useCallback(() => {
        // Ensure we're on the avatar step, so the wizard shows the new photo
        // when the surface closes.
        if (avatarStepIndex >= 0 && currentStep !== avatarStepIndex) {
            animateToStepCallback(avatarStepIndex);
        }
        openChangeAvatarSurface();
    }, [openChangeAvatarSurface, currentStep, avatarStepIndex, animateToStepCallback]);

    // Shared Dialog nav header: a stable "Welcome" title, the wizard `progress`
    // bar (replacing the old in-content dots), and a back affordance that steps the
    // wizard back once past the intro (the step CTAs keep their own
    // Back/Skip/Next/Enter buttons as content; the header's close dismisses,
    // matching the pre-existing backdrop-dismiss).
    const progress = useMemo(
        () => ({ step: currentStep + 1, total: totalSteps }),
        [currentStep, totalSteps],
    );
    useSurfaceHeader({
        title: t('welcomeNew.navTitle'),
        largeTitle: false,
        onBack: currentStep > 0 ? prevStep : undefined,
        progress,
    });

    const step = steps[currentStep];
    const renderActionButtons = useCallback(() => {
        if (currentStep === totalSteps - 1) {
            return (
                <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                    <Button variant="secondary" onPress={prevStep} size="small">
                        {t('welcomeNew.actions.back') || 'Back'}
                    </Button>
                    <Button variant="primary" onPress={finish} size="small">
                        {t('welcomeNew.actions.enter') || 'Enter'}
                    </Button>
                </View>
            );
        }
        if (currentStep === 0) {
            return (
                <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                    {avatarStepIndex > 0 && (
                        <Button variant="secondary" onPress={skipToAvatar} size="small">
                            {t('welcomeNew.actions.skip') || 'Skip'}
                        </Button>
                    )}
                    <Button variant="primary" onPress={nextStep} size="small">
                        {t('welcomeNew.actions.next') || 'Next'}
                    </Button>
                </View>
            );
        }
        if (nameStepIndex >= 0 && currentStep === nameStepIndex) {
            return (
                <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                    <Button variant="secondary" onPress={prevStep} size="small">
                        {t('welcomeNew.actions.back') || 'Back'}
                    </Button>
                    <Button variant="primary" onPress={submitName} size="small" disabled={!firstName.trim() || savingName} loading={savingName}>
                        {t('welcomeNew.actions.continue') || 'Continue'}
                    </Button>
                </View>
            );
        }
        if (step.showAvatar) {
            return (
                <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                    <Button variant="secondary" onPress={prevStep} size="small">
                        {t('welcomeNew.actions.back') || 'Back'}
                    </Button>
                    <Button variant="primary" onPress={nextStep} size="small">
                        {avatarUri ? (t('welcomeNew.actions.continue') || 'Continue') : (t('welcomeNew.actions.skip') || 'Skip')}
                    </Button>
                </View>
            );
        }
        return (
            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="secondary" onPress={prevStep} size="small">
                    {t('welcomeNew.actions.back') || 'Back'}
                </Button>
                <Button variant="primary" onPress={nextStep} size="small">
                    {t('welcomeNew.actions.next') || 'Next'}
                </Button>
            </View>
        );
    }, [currentStep, totalSteps, prevStep, nextStep, finish, skipToAvatar, avatarStepIndex, nameStepIndex, submitName, firstName, savingName, step.showAvatar, avatarUri, t]);

    return (
        <View style={styles.container}>
            {/* Step progress now lives in the shared Dialog header (`progress`). */}
            <Animated.View style={{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] }}>
                <View style={[styles.scrollInner, styles.contentContainer]}>
                    <View style={[styles.header, styles.sectionSpacing]}>
                        <H1 style={styles.title} className="text-text">{step.title}</H1>
                        {step.body && <Text style={styles.body} className="text-text-secondary">{step.body}</Text>}
                    </View>
                    {Array.isArray(step.bullets) && step.bullets.length > 0 && (
                        <View style={[styles.bulletContainer, styles.sectionSpacing]}>
                            {step.bullets.map(b => (
                                <View key={b} style={styles.bulletRow}>
                                    <Ionicons name="ellipse" size={8} color={colors.primary} style={{ marginTop: 6 }} />
                                    <Text style={styles.bulletText} className="text-text-secondary">{b}</Text>
                                </View>
                            ))}
                        </View>
                    )}
                    {step.showNameForm && (
                        <View style={[styles.nameForm, styles.sectionSpacing]}>
                            <View style={styles.nameField}>
                                <TextField>
                                    <TextFieldInput
                                        floatingLabel
                                        label={t('welcomeNew.name.firstLabel') || 'First name'}
                                        value={firstName}
                                        onChangeText={setFirstName}
                                        autoFocus
                                        autoCapitalize="words"
                                    />
                                </TextField>
                            </View>
                            <View style={styles.nameField}>
                                <TextField>
                                    <TextFieldInput
                                        floatingLabel
                                        label={t('welcomeNew.name.lastLabel') || 'Last name'}
                                        value={lastName}
                                        onChangeText={setLastName}
                                        autoCapitalize="words"
                                    />
                                </TextField>
                            </View>
                        </View>
                    )}
                    {step.showAvatar && (
                        <View style={[styles.avatarSection, styles.sectionSpacing]}>
                            <Avatar
                                size={120}
                                name={welcomeName}
                                source={avatarUri}
                                placeholderColor={`${colors.primary}20`}
                                style={styles.avatar}
                            />
                            <Button variant="primary" size="small" onPress={openAvatarPicker}>
                                {avatarUri ? (t('welcomeNew.avatar.change') || 'Change Avatar') : (t('welcomeNew.avatar.add') || 'Add Avatar')}
                            </Button>
                        </View>
                    )}
                    <View style={styles.sectionSpacing}>
                        {renderActionButtons()}
                    </View>
                </View>
            </Animated.View>
        </View>
    );

};

const createStyles = () => {
    return StyleSheet.create({
        container: {
            width: '100%',
            paddingHorizontal: 20,
        },
        scrollInner: {
            paddingTop: 0,
        },
        contentContainer: {
            width: '100%',
            maxWidth: 420,
            alignSelf: 'center',
        },
        sectionSpacing: {
            marginBottom: GAP,
        },
        header: {
            alignItems: 'flex-start',
            width: '100%',
            gap: INNER_GAP / 2,
        },
        title: {
            fontSize: 42,
            letterSpacing: -1,
            textAlign: 'left',
        },
        body: {
            fontSize: 16,
            lineHeight: 22,
            textAlign: 'left',
            maxWidth: 320,
            alignSelf: 'flex-start',
        },
        bulletContainer: {
            gap: INNER_GAP,
            width: '100%',
        },
        bulletRow: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 10,
        },
        bulletText: {
            flex: 1,
            fontSize: 15,
            lineHeight: 20,
        },
        nameForm: {
            width: '100%',
            gap: GAP,
        },
        nameField: {
            width: '100%',
            gap: INNER_GAP / 2,
        },
        avatarSection: {
            width: '100%',
            alignItems: 'center',
        },
        avatar: {
            marginBottom: INNER_GAP,
        },
    });
};

export default WelcomeNewUserScreen;
