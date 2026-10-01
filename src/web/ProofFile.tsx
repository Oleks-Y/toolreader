import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { ProofArtifact } from "../core/proof.ts";
import { ActionView } from "./ActionView.tsx";
import { ThemePicker } from "./theme.tsx";

const decodeArtifact = Schema.decodeUnknownExit(Schema.fromJsonString(ProofArtifact));

/** Opens a committed proof-of-work file (.agent-work/<branch>/*.json) in the same viewer, offline. */
export function ProofFile() {
  const [artifact, setArtifact] = useState<ProofArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const open = async (file: File | undefined) => {
    if (!file) return;
    const exit = decodeArtifact(await file.text());
    if (Exit.isSuccess(exit)) {
      setError(null);
      setArtifact(exit.value);
    } else {
      setArtifact(null);
      setError(`${file.name} is not a toolreader proof file (or uses a newer format).`);
    }
  };

  if (artifact)
    return <ActionView key={artifact.exportedAt + artifact.view.thread.id} artifact={artifact} />;
  return (
    <main className="sessions">
      <header className="topbar">
        <h1>toolreader</h1>
        <ThemePicker />
        <a href="#/">← sessions</a>
      </header>
      <label
        className={`dropzone${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void open(e.dataTransfer.files[0]);
        }}
      >
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => void open(e.target.files?.[0])}
        />
        <b>Open a proof-of-work file</b>
        <span className="dim">Drop a .json from .agent-work/ here, or click to choose one.</span>
      </label>
      {error && <div className="error">{error}</div>}
    </main>
  );
}
