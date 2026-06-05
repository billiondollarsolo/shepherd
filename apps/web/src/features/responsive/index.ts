/**
 * Responsive / PWA feature (US-36, FR-UI6): the phone-friendly away view and the
 * viewport-driven collapse from the desktop paddock. Public surface for App.
 */
export { ResponsivePaddock } from './ResponsivePaddock.js';

export { PhoneView } from './PhoneView.js';
export type { PhoneSession, PhoneViewProps } from './PhoneView.js';

export { useIsPhone, PHONE_MEDIA_QUERY } from './useIsPhone.js';
