import type Ionicons from "../../icons/Ionicons";
import type { ThemeColors } from "@oxyhq/bloom/theme";
import type React from "react";
import type { Animated } from "react-native";

export type PaymentItem = {
	type: "product" | "subscription" | "service" | "fee" | string;
	name: string;
	description?: string;
	quantity?: number;
	period?: string;
	price: number;
	currency?: string;
};

export interface PaymentGatewayResult {
	success: boolean;
	details?: Record<string, string | number | boolean | null>;
	error?: string;
}

export interface CardDetails {
	number: string;
	expiry: string;
	cvv: string;
}

export interface PaymentMethod {
	key: string;
	label: string;
	icon: React.ComponentProps<typeof Ionicons>["name"];
	description: string;
}

export interface PaymentStepAnimations {
	fadeAnim: Animated.Value;
	slideAnim: Animated.Value;
	scaleAnim: Animated.Value;
}

/**
 * Payment wizard steps consume bloom's ThemeColors directly (no adapter).
 * Screen shells pass `useTheme().colors` straight through.
 */
export type PaymentColors = ThemeColors;
