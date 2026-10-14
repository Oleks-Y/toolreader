import { useQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { BlameView } from "../../web/BlamePage.tsx";
import { blameOptions } from "../queries.ts";

const Search = Schema.toStandardSchemaV1(Schema.Struct({ url: Schema.optional(Schema.String) }));

export const Route = createFileRoute("/$owner/$repo/blame")({
  validateSearch: Search,
  component: Blame,
});

function Blame() {
  const { url } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [input, setInput] = useState(url ?? "");
  // Asked from the browser, not the loader: the first ask of a hunk waits on TypeSafe.
  const { data, error, isFetching } = useQuery({ ...blameOptions(url ?? ""), enabled: !!url });
  return (
    <div className="blame">
      <form
        className="blame-form"
        onSubmit={(e) => {
          e.preventDefault();
          navigate({ search: { url: input.trim() } });
        }}
      >
        <input
          aria-label="GitHub line link"
          placeholder="Paste a line link from a GitHub PR's files (click a line number, copy the address)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="chip on" type="submit" disabled={!input.trim()}>
          blame
        </button>
      </form>
      {isFetching && (
        <p className="dim">Finding the commit, its threads, and asking Jev… (a few seconds)</p>
      )}
      {error && <div className="error">{error.message}</div>}
      {data && !data.ok && <div className="error">{data.message}</div>}
      {data?.ok && (
        <ClientOnly fallback={<p className="dim">loading…</p>}>
          <BlameView result={data.result} />
        </ClientOnly>
      )}
    </div>
  );
}
