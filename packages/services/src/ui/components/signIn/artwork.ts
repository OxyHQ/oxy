/**
 * The photos the sign-in split card's carousel turns through. Shipped with the
 * SDK and imported like its icon fonts, so every host serves them from its own
 * origin — nothing to allow in anyone's CSP.
 */

import type { AuthMediaSlide } from '@oxy.so/bloom/auth-card';
import slide1 from '../../../assets/signIn/slide-1.jpg';
import slide2 from '../../../assets/signIn/slide-2.jpg';
import slide3 from '../../../assets/signIn/slide-3.jpg';
import slide4 from '../../../assets/signIn/slide-4.jpg';

export const SIGN_IN_SLIDES: AuthMediaSlide[] = [slide1, slide2, slide3, slide4].map((source) => ({ source }));
