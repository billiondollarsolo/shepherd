import { lazy, Suspense } from 'react';
import { useIsPhone } from './useIsPhone';

const DesktopPaddock = lazy(() =>
  import('../../app/Paddock').then(({ Paddock }) => ({ default: Paddock })),
);
const PhonePaddock = lazy(() =>
  import('./PhonePaddock').then(({ PhonePaddock: Phone }) => ({ default: Phone })),
);

function SurfaceLoading(): JSX.Element {
  return (
    <div
      className="flex h-dvh w-full items-center justify-center bg-flock-bg text-sm text-flock-ink-muted"
      role="status"
    >
      Opening Flock…
    </div>
  );
}

/** Loads only the terminal/UI surface needed by the current device class. */
export function ResponsivePaddock(): JSX.Element {
  const isPhone = useIsPhone();
  return (
    <Suspense fallback={<SurfaceLoading />}>
      {isPhone ? <PhonePaddock /> : <DesktopPaddock />}
    </Suspense>
  );
}
