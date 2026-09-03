"use client";

/**
 * The departure board: every irreversible act this session has asked for.
 *
 * Denials sit in the same table as approvals and in the same type, because a
 * refusal here is a normal outcome rather than an incident. The "why" column is
 * the engine's own sentence, truncated by the layout and never by us.
 */

import { money } from "@/app/_shared/content";
import { useSession } from "@/components/state/session";
import type { ActView } from "@/app/_shared/view";

export function ActBoard({ acts }: { acts: ActView[] }) {
  const { selectedActId, select } = useSession();

  if (acts.length === 0) {
    return (
      <p className="board__empty">
        No irreversible act has been asked for yet. Reversible work — searches, drafts, conversions,
        diligence — does not appear here, because none of it needs authority.
      </p>
    );
  }

  const shown = [...acts].reverse();

  return (
    <div className="board__scroll">
      <table className="board">
        <caption className="sr">Irreversible acts and the verdict each received</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Act</th>
            <th scope="col">Cost</th>
            <th scope="col">Verdict</th>
            <th scope="col">Reason given</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((act) => {
            const reason = act.reasons[0];
            const selected = selectedActId === act.id;
            return (
              <tr
                key={act.id}
                data-run="1"
                data-sel={selected ? "1" : undefined}
                tabIndex={0}
                role="button"
                aria-pressed={selected}
                onClick={() => select(act.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select(act.id);
                  }
                }}
              >
                <td className="board__t">{act.at.slice(11, 19)}</td>
                <td>
                  <b>{String(act.fields.domainName ?? act.kind)}</b>
                  <small>{act.kind}</small>
                </td>
                <td className="board__t">
                  {act.amountMinorUnits === null
                    ? "—"
                    : money(act.amountMinorUnits, act.currency ?? "USD")}
                </td>
                <td>
                  <span className={`pill ${act.outcome === "allow" ? "pill--go" : "pill--stop"}`}>
                    {act.outcome === "allow" ? "Allowed" : "Denied"}
                  </span>
                </td>
                <td className="board__why">
                  {reason?.message}
                  {reason?.clauseRef !== undefined && (
                    <span className="board__cite">
                      clause {reason.clauseRef}
                      {reason.pageNumber !== undefined && `, page ${reason.pageNumber}`}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
