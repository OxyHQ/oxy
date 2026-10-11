/**
 * App Initialization Service
 * Simplified version for Accounts app
 */

import * as SplashScreen from 'expo-splash-screen';

export interface InitializationResult {
  success: boolean;
  error?: Error;
}

/**
 * Main app initialization function
 * Coordinates all initialization steps
 */
export class AppInitializer {
  /**
   * Initializes the entire app
   */
  static async initializeApp(fontsLoaded: boolean): Promise<InitializationResult> {
    if (!fontsLoaded) {
      return {
        success: false,
        error: new Error('Fonts not loaded'),
      };
    }

    try {
      // Hide splash screen
      try {
        await SplashScreen.hideAsync();
      } catch (error) {
        console.warn('Failed to hide native splash screen:', error);
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error('Unknown initialization error'),
      };
    }
  }
}
