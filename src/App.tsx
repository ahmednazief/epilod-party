import { SettingsModal } from "./components/SettingsModal";
import { HomeScreen } from "./components/HomeScreen";
import { WatchRoom } from "./components/WatchRoom";
import { useAppStore } from "./store/useAppStore";

export function App() {
  const screen = useAppStore((s) => s.screen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const closeSettings = useAppStore((s) => s.closeSettings);

  const liquidLensSvg = (
    <svg
      width="0"
      height="0"
      className="fixed pointer-events-none"
      aria-hidden="true"
    >
      <defs>
        <filter
          id="epilod-liquid-lens"
          x="-15%"
          y="-15%"
          width="130%"
          height="130%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.011 0.017"
            numOctaves="2"
            seed="11"
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation="5" result="softNoise" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="softNoise"
            scale="22"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );

  if (screen === "room") {
    return (
      <>
        {liquidLensSvg}
        <WatchRoom />
      </>
    );
  }

  return (
    <>
      {liquidLensSvg}
      <HomeScreen />
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
    </>
  );
}

export default App;
