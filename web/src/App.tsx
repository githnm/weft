import { useState } from "react";

import { AppSidebar, type View } from "@/components/app-sidebar";
import { AskScreen } from "@/screens/ask";
import { ModelsScreen } from "@/screens/models";
import { ContextScreen } from "@/screens/context";
import { ConnectionsScreen } from "@/screens/connections";

export default function App() {
  const [view, setView] = useState<View>("ask");

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <AppSidebar view={view} onNavigate={setView} />
      <main className="flex-1 overflow-y-auto">
        {view === "ask" && <AskScreen />}
        {view === "models" && <ModelsScreen />}
        {view === "context" && <ContextScreen />}
        {view === "connections" && <ConnectionsScreen />}
      </main>
    </div>
  );
}
