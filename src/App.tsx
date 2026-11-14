import { SettingsModal } from "./components/SettingsModal";
import { HomeScreen } from "./components/HomeScreen";
import { WatchRoom } from "./components/WatchRoom";
import { useAppStore } from "./store/useAppStore";

export function App() {
  const screen = useAppStore((s) => s.screen);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const closeSettings = useAppStore((s) => s.closeSettings);

  if (screen === "room") {
    return <WatchRoom />;
  }

  return (
    <>
      <HomeScreen />
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
    </>
  );
}

export default App;
