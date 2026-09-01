import Ionicons from "../icons/Ionicons";
import type MaterialCommunityIcons from "../icons/MaterialCommunityIcons";
import { Button } from "@oxyhq/bloom/button";
import {
	SettingsListGroup,
	SettingsListItem,
} from "@oxyhq/bloom/settings-list";
import { Switch } from "@oxyhq/bloom/switch";
import { TextField, TextFieldInput } from "@oxyhq/bloom/text-field";
import { useTheme } from "@oxyhq/bloom/theme";
import { toast } from "@oxyhq/bloom/toast";
import { H2, Text } from "@oxyhq/bloom/typography";
import { normalizeTheme } from "@oxyhq/core";
import { packageInfo } from "@oxyhq/core";
import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Animated, Platform, StyleSheet, View } from "react-native";
import { SettingsIcon } from "../components/SettingsIcon";
import { useOxy } from "../context/OxyContext";
import { useI18n } from "../hooks/useI18n";
import { useSurfaceHeader } from "../hooks/useSurfaceHeader";
import type { BaseScreenProps } from "../types/navigation";

import {
	CATEGORIES,
	FEEDBACK_TYPES,
	PRIORITY_LEVELS,
} from "../components/feedback/constants";
import type { FeedbackData } from "../components/feedback/types";
import { useFeedbackForm } from "../components/feedback/useFeedbackForm";

/** Step transition timing — measured animation, not a design token. */
const STEP_FADE_OUT_MS = 250;
const STEP_FADE_IN_MS = 250;
const STEP_SLIDE_IN_MS = 300;
const STEP_SLIDE_FROM = -100;
const TOTAL_STEPS = 4;
const LAST_STEP_INDEX = TOTAL_STEPS - 1;
const SUCCESS_RESET_DELAY_MS = 3000;

/** Maps each feedback type to a Bloom theme role + MaterialCommunityIcons glyph. */
const TYPE_ICON_GLYPH: Record<
	FeedbackData["type"],
	React.ComponentProps<typeof MaterialCommunityIcons>["name"]
> = {
	bug: "bug",
	feature: "lightbulb-on",
	general: "chat",
	support: "help-circle",
};

/** Maps each priority level to a MaterialCommunityIcons glyph. */
const PRIORITY_ICON_GLYPH: Record<
	FeedbackData["priority"],
	React.ComponentProps<typeof MaterialCommunityIcons>["name"]
> = {
	low: "arrow-down",
	medium: "minus",
	high: "arrow-up",
	critical: "alert",
};

const FeedbackScreen: React.FC<BaseScreenProps> = ({
	goBack,
	onClose,
	theme,
}) => {
	const { user, oxyServices } = useOxy();
	const normalizedTheme = normalizeTheme(theme);
	const bloomTheme = useTheme();
	const colors = bloomTheme.colors;
	const { t } = useI18n();

	useSurfaceHeader({ title: t("feedback.title") || "Feedback" });

	const {
		feedbackData,
		feedbackState,
		setFeedbackState,
		updateField,
		resetForm,
	} = useFeedbackForm();

	const [currentStep, setCurrentStep] = useState(0);
	const [, setErrorMessage] = useState("");

	const fadeAnim = useRef(new Animated.Value(1)).current;
	const slideAnim = useRef(new Animated.Value(0)).current;

	/** Theme-role color for each feedback type pill. */
	const typeColor = useCallback(
		(id: FeedbackData["type"]): string => {
			switch (id) {
				case "bug":
					return colors.negative;
				case "feature":
					return colors.info;
				case "general":
					return colors.success;
				case "support":
					return colors.warning;
				default:
					return colors.primary;
			}
		},
		[colors],
	);

	/** Theme-role color for each priority level. */
	const priorityColor = useCallback(
		(id: FeedbackData["priority"]): string => {
			switch (id) {
				case "low":
					return colors.success;
				case "medium":
					return colors.warning;
				case "high":
					return colors.negative;
				case "critical":
					return colors.negative;
				default:
					return colors.primary;
			}
		},
		[colors],
	);

	const animateTransition = useCallback(
		(nextStep: number) => {
			Animated.timing(fadeAnim, {
				toValue: 0,
				duration: STEP_FADE_OUT_MS,
				useNativeDriver: Platform.OS !== "web",
			}).start(() => {
				setCurrentStep(nextStep);
				slideAnim.setValue(STEP_SLIDE_FROM);

				Animated.parallel([
					Animated.timing(fadeAnim, {
						toValue: 1,
						duration: STEP_FADE_IN_MS,
						useNativeDriver: Platform.OS !== "web",
					}),
					Animated.timing(slideAnim, {
						toValue: 0,
						duration: STEP_SLIDE_IN_MS,
						useNativeDriver: Platform.OS !== "web",
					}),
				]).start();
			});
		},
		[fadeAnim, slideAnim],
	);

	const nextStep = useCallback(() => {
		if (currentStep < LAST_STEP_INDEX) {
			animateTransition(currentStep + 1);
		}
	}, [currentStep, animateTransition]);

	const prevStep = useCallback(() => {
		if (currentStep > 0) {
			animateTransition(currentStep - 1);
		}
	}, [currentStep, animateTransition]);

	const isTypeStepValid = useCallback(() => {
		return Boolean(feedbackData.type && feedbackData.category);
	}, [feedbackData.type, feedbackData.category]);

	const isDetailsStepValid = useCallback(() => {
		return Boolean(
			feedbackData.title.trim() && feedbackData.description.trim(),
		);
	}, [feedbackData.title, feedbackData.description]);

	const isContactStepValid = useCallback(() => {
		return Boolean(feedbackData.contactEmail.trim() || user?.email);
	}, [feedbackData.contactEmail, user?.email]);

	const handleSubmitFeedback = useCallback(async () => {
		if (!isTypeStepValid() || !isDetailsStepValid() || !isContactStepValid()) {
			toast.error(
				t("feedback.toasts.fillRequired") ||
					"Please fill in all required fields",
			);
			return;
		}

		try {
			setFeedbackState({ status: "submitting", message: "" });
			setErrorMessage("");

			const feedbackPayload = {
				type: feedbackData.type,
				title: feedbackData.title,
				description: feedbackData.description,
				priority: feedbackData.priority,
				category: feedbackData.category,
				contactEmail: feedbackData.contactEmail || user?.email,
				systemInfo: feedbackData.systemInfo
					? {
							platform: Platform.OS,
							version: Platform.Version?.toString() || "Unknown",
							appVersion: packageInfo.version,
							userId: user?.id,
							username: user?.username,
							timestamp: new Date().toISOString(),
						}
					: undefined,
			};

			await oxyServices.submitFeedback(feedbackPayload);

			setFeedbackState({
				status: "success",
				message:
					t("feedback.toasts.submitSuccess") ||
					"Feedback submitted successfully!",
			});
			toast.success(
				t("feedback.toasts.thanks") || "Thank you for your feedback!",
			);

			setTimeout(() => {
				resetForm();
				setCurrentStep(0);
			}, SUCCESS_RESET_DELAY_MS);
		} catch (error: unknown) {
			const message =
				(error instanceof Error ? error.message : null) ||
				t("feedback.toasts.submitFailed") ||
				"Failed to submit feedback";
			setFeedbackState({ status: "error", message });
			toast.error(message);
		}
	}, [
		feedbackData,
		user,
		oxyServices,
		isTypeStepValid,
		isDetailsStepValid,
		isContactStepValid,
		resetForm,
		setFeedbackState,
		t,
	]);

	const feedbackTypeData = useMemo(
		() =>
			FEEDBACK_TYPES.map((type) => ({
				...type,
				isSelected: feedbackData.type === type.id,
			})),
		[feedbackData.type],
	);

	const categoryData = useMemo(
		() =>
			feedbackData.type
				? (CATEGORIES[feedbackData.type] || []).map((cat) => ({
						name: cat,
						isSelected: feedbackData.category === cat,
					}))
				: [],
		[feedbackData.type, feedbackData.category],
	);

	const priorityData = useMemo(
		() =>
			PRIORITY_LEVELS.map((p) => ({
				...p,
				isSelected: feedbackData.priority === p.id,
			})),
		[feedbackData.priority],
	);

	const renderProgress = () => (
		<View
			className="flex-row justify-center gap-space-8 pt-space-8 pb-space-16"
			accessibilityRole="progressbar"
			accessibilityLabel={`Step ${currentStep + 1} of ${TOTAL_STEPS}`}
		>
			{Array.from({ length: TOTAL_STEPS }, (_, index) => (
				<View
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed step indicators, order never changes
					key={index}
					className={
						currentStep === index
							? "h-space-8 rounded-radius-max bg-fill-brand"
							: "h-space-8 rounded-radius-max bg-fill-secondary"
					}
					style={
						currentStep === index
							? styles.progressDotActive
							: styles.progressDot
					}
				/>
			))}
		</View>
	);

	const renderStepHeader = (title: string, subtitle: string) => (
		<View className="w-full gap-space-8 mb-space-24">
			<H2 className="text-headerBold font-headerBold text-text">{title}</H2>
			<Text className="text-body font-body text-text-secondary">
				{subtitle}
			</Text>
		</View>
	);

	const renderTypeStep = () => (
		<Animated.View
			style={[
				styles.stepContainer,
				{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] },
			]}
		>
			{renderStepHeader(
				t("feedback.type.title") || "What type of feedback?",
				t("feedback.type.subtitle") ||
					"Choose the category that best describes your feedback",
			)}

			<View className="w-full">
				<SettingsListGroup>
					{feedbackTypeData.map((type) => (
						<SettingsListItem
							key={type.id}
							icon={
								<SettingsIcon
									name={TYPE_ICON_GLYPH[type.id]}
									color={typeColor(type.id)}
								/>
							}
							title={type.label}
							description={type.description}
							onPress={() => {
								updateField("type", type.id);
								updateField("category", "");
							}}
							showChevron={false}
						/>
					))}
				</SettingsListGroup>
			</View>

			{feedbackData.type ? (
				<View className="w-full mt-space-24">
					<Text className="text-caption font-caption text-text-secondary mb-space-8">
						{t("feedback.category.label") || "Category"}
					</Text>
					<View className="w-full">
						<SettingsListGroup>
							{categoryData.map((cat) => (
								<SettingsListItem
									key={cat.name}
									icon={
										<SettingsIcon
											name={cat.isSelected ? "check-circle" : "circle-outline"}
											color={
												cat.isSelected ? colors.primary : colors.textSecondary
											}
										/>
									}
									title={cat.name}
									onPress={() => updateField("category", cat.name)}
									showChevron={false}
								/>
							))}
						</SettingsListGroup>
					</View>
				</View>
			) : null}

			<View className="flex-row gap-space-8 mt-space-24 w-full">
				<Button
					variant="secondary"
					onPress={goBack}
					accessibilityLabel="Go back"
					icon={<Ionicons name="arrow-back" size={16} color={colors.text} />}
					style={styles.navButton}
				>
					{t("common.actions.back") || "Back"}
				</Button>

				<Button
					variant="primary"
					onPress={nextStep}
					disabled={!isTypeStepValid()}
					accessibilityLabel="Continue to next step"
					iconPosition="right"
					icon={
						<Ionicons
							name="arrow-forward"
							size={16}
							color={colors.primaryForeground}
						/>
					}
					style={styles.navButton}
				>
					{t("common.actions.next") || "Next"}
				</Button>
			</View>
		</Animated.View>
	);

	const renderDetailsStep = () => (
		<Animated.View
			style={[
				styles.stepContainer,
				{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] },
			]}
		>
			{renderStepHeader(
				t("feedback.details.title") || "Tell us more",
				t("feedback.details.subtitle") || "Provide details about your feedback",
			)}

			<View className="w-full gap-space-16">
				<TextField>
					<TextFieldInput
						floatingLabel
						label={t("feedback.fields.title.label") || "Title"}
						value={feedbackData.title}
						onChangeText={(text) => {
							updateField("title", text);
							setErrorMessage("");
						}}
						placeholder={
							t("feedback.fields.title.placeholder") ||
							"Brief summary of your feedback"
						}
						testID="feedback-title-input"
						accessibilityLabel="Feedback title"
						accessibilityHint="Enter a brief summary of your feedback"
					/>
				</TextField>

				<TextField>
					<TextFieldInput
						floatingLabel
						multiline
						numberOfLines={6}
						label={t("feedback.fields.description.label") || "Description"}
						value={feedbackData.description}
						onChangeText={(text) => {
							updateField("description", text);
							setErrorMessage("");
						}}
						placeholder={
							t("feedback.fields.description.placeholder") ||
							"Please provide detailed information..."
						}
						testID="feedback-description-input"
						accessibilityLabel="Feedback description"
						accessibilityHint="Provide detailed information about your feedback"
					/>
				</TextField>
			</View>

			<View className="w-full mt-space-24">
				<Text className="text-caption font-caption text-text-secondary mb-space-8">
					{t("feedback.priority.label") || "Priority Level"}
				</Text>
				<View className="w-full">
					<SettingsListGroup>
						{priorityData.map((p) => (
							<SettingsListItem
								key={p.id}
								icon={
									<SettingsIcon
										name={PRIORITY_ICON_GLYPH[p.id]}
										color={priorityColor(p.id)}
									/>
								}
								title={p.label}
								onPress={() => updateField("priority", p.id)}
								showChevron={false}
							/>
						))}
					</SettingsListGroup>
				</View>
			</View>

			<View className="flex-row gap-space-8 mt-space-24 w-full">
				<Button
					variant="secondary"
					onPress={prevStep}
					accessibilityLabel="Go back"
					icon={<Ionicons name="arrow-back" size={16} color={colors.text} />}
					style={styles.navButton}
				>
					{t("common.actions.back") || "Back"}
				</Button>

				<Button
					variant="primary"
					onPress={nextStep}
					disabled={!isDetailsStepValid()}
					accessibilityLabel="Continue to next step"
					iconPosition="right"
					icon={
						<Ionicons
							name="arrow-forward"
							size={16}
							color={colors.primaryForeground}
						/>
					}
					style={styles.navButton}
				>
					{t("common.actions.next") || "Next"}
				</Button>
			</View>
		</Animated.View>
	);

	const renderContactStep = () => (
		<Animated.View
			style={[
				styles.stepContainer,
				{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] },
			]}
		>
			{renderStepHeader(
				t("feedback.contact.title") || "Contact Information",
				t("feedback.contact.subtitle") || "Help us get back to you",
			)}

			<View className="w-full">
				<TextField>
					<TextFieldInput
						floatingLabel
						label={t("feedback.fields.email.label") || "Email Address"}
						value={feedbackData.contactEmail}
						onChangeText={(text) => {
							updateField("contactEmail", text);
							setErrorMessage("");
						}}
						placeholder={
							user?.email ||
							t("feedback.fields.email.placeholder") ||
							"Enter your email address"
						}
						keyboardType="email-address"
						autoCapitalize="none"
						autoCorrect={false}
						testID="feedback-email-input"
						accessibilityLabel="Email address"
						accessibilityHint="Enter your email so we can respond"
					/>
				</TextField>
			</View>

			<View className="w-full mt-space-16">
				<SettingsListGroup>
					<SettingsListItem
						icon={<SettingsIcon name="information" color={colors.info} />}
						title={
							t("feedback.contact.includeSystemInfo") ||
							"Include system information to help us better understand your issue"
						}
						rightElement={
							<Switch
								value={feedbackData.systemInfo}
								onValueChange={(value) => updateField("systemInfo", value)}
								testID="feedback-system-info-switch"
							/>
						}
						showChevron={false}
					/>
				</SettingsListGroup>
			</View>

			<View className="flex-row gap-space-8 mt-space-24 w-full">
				<Button
					variant="secondary"
					onPress={prevStep}
					accessibilityLabel="Go back"
					icon={<Ionicons name="arrow-back" size={16} color={colors.text} />}
					style={styles.navButton}
				>
					{t("common.actions.back") || "Back"}
				</Button>

				<Button
					variant="primary"
					onPress={nextStep}
					disabled={!isContactStepValid()}
					accessibilityLabel="Continue to summary"
					iconPosition="right"
					icon={
						<Ionicons
							name="arrow-forward"
							size={16}
							color={colors.primaryForeground}
						/>
					}
					style={styles.navButton}
				>
					{t("common.actions.next") || "Next"}
				</Button>
			</View>
		</Animated.View>
	);

	const renderSummaryRow = (label: string, value: string | undefined) => (
		<View className="flex-row gap-space-12">
			<Text
				className="text-body font-body text-text-secondary"
				style={styles.summaryLabel}
			>
				{label}
			</Text>
			<Text className="text-body font-body text-text flex-1">{value}</Text>
		</View>
	);

	const renderSummaryStep = () => (
		<Animated.View
			style={[
				styles.stepContainer,
				{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] },
			]}
		>
			{renderStepHeader(
				t("feedback.summary.title") || "Summary",
				t("feedback.summary.subtitle") ||
					"Please review your feedback before submitting",
			)}

			<View className="w-full gap-space-12 p-space-16 rounded-radius-20 bg-fill mb-space-24">
				{renderSummaryRow(
					t("feedback.summary.type") || "Type:",
					FEEDBACK_TYPES.find((ft) => ft.id === feedbackData.type)?.label,
				)}
				{renderSummaryRow(
					t("feedback.summary.category") || "Category:",
					feedbackData.category,
				)}
				{renderSummaryRow(
					t("feedback.summary.priority") || "Priority:",
					PRIORITY_LEVELS.find((p) => p.id === feedbackData.priority)?.label,
				)}
				{renderSummaryRow(
					t("feedback.summary.titleField") || "Title:",
					feedbackData.title,
				)}
				{renderSummaryRow(
					t("feedback.summary.contact") || "Contact:",
					feedbackData.contactEmail || user?.email,
				)}
			</View>

			<Button
				variant="primary"
				onPress={handleSubmitFeedback}
				disabled={feedbackState.status === "submitting"}
				loading={feedbackState.status === "submitting"}
				testID="submit-feedback-button"
				accessibilityLabel="Submit feedback"
				iconPosition="right"
				icon={
					<Ionicons name="send" size={18} color={colors.primaryForeground} />
				}
				style={styles.fullWidthButton}
			>
				{t("feedback.actions.submit") || "Submit Feedback"}
			</Button>

			<View className="flex-row mt-space-16 w-full">
				<Button
					variant="secondary"
					onPress={prevStep}
					accessibilityLabel="Go back"
					icon={<Ionicons name="arrow-back" size={16} color={colors.text} />}
					style={styles.navButton}
				>
					{t("common.actions.back") || "Back"}
				</Button>
			</View>
		</Animated.View>
	);

	const renderSuccessStep = () => (
		<Animated.View
			style={[
				styles.stepContainer,
				{ opacity: fadeAnim, transform: [{ translateX: slideAnim }] },
			]}
		>
			<View className="w-full items-center justify-center p-space-32 gap-space-16">
				<View className="p-space-24 rounded-radius-max bg-fill-secondary">
					<Ionicons name="checkmark-circle" size={48} color={colors.success} />
				</View>
				<H2 className="text-headerBold font-headerBold text-text text-center">
					{t("feedback.success.thanks") || "Thank You!"}
				</H2>
				<Text className="text-body font-body text-text-secondary text-center">
					{t("feedback.success.message") ||
						"Your feedback has been submitted successfully. We'll review it and get back to you soon."}
				</Text>
				<Button
					variant="primary"
					onPress={() => {
						resetForm();
						setCurrentStep(0);
					}}
					accessibilityLabel="Submit another feedback"
					style={styles.fullWidthButton}
				>
					{t("feedback.actions.submitAnother") || "Submit Another"}
				</Button>
			</View>
		</Animated.View>
	);

	const renderCurrentStep = () => {
		if (feedbackState.status === "success") return renderSuccessStep();
		switch (currentStep) {
			case 0:
				return renderTypeStep();
			case 1:
				return renderDetailsStep();
			case 2:
				return renderContactStep();
			case 3:
				return renderSummaryStep();
			default:
				return renderTypeStep();
		}
	};

	return (
		<>
			<View className="px-screen-margin pt-space-24 pb-space-32">
				{feedbackState.status !== "success" ? renderProgress() : null}
				{renderCurrentStep()}
			</View>
		</>
	);
};

const styles = StyleSheet.create({
	stepContainer: {
		flex: 1,
		alignItems: "flex-start",
	},
	navButton: {
		flex: 1,
	},
	fullWidthButton: {
		width: "100%",
	},
	summaryLabel: {
		width: 90,
	},
	progressDot: {
		width: 8,
	},
	progressDotActive: {
		width: 24,
	},
});

export default FeedbackScreen;
