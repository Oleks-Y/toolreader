import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActionView } from "./ActionView.tsx";
import { ProofFile } from "./ProofFile.tsx";
import { Sessions } from "./Sessions.tsx";
import { applySavedTheme } from "./theme.tsx";
import "./themes.css";
import "./style.css";

applySavedTheme();

function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  if (hash === "#/file") return <ProofFile />;
  const thread = /^#\/t\/(.+)$/.exec(hash)?.[1];
  return thread ? <ActionView key={thread} threadId={decodeURIComponent(thread)} /> : <Sessions />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
