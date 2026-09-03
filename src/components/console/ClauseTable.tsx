"use client";

/**
 * The instrument itself, clause by clause.
 *
 * The grant clauses are rendered from the same `Grant` objects the gatekeeper
 * walks, so the readable term and the enforced term cannot drift. When an act
 * is refused the clause it cited is highlighted here — this is the "open the
 * PDF at the page that says three" moment, done without a PDF viewer.
 */

import { clauseTable } from "@/app/_shared/content";
import type { ActView, WritView } from "@/app/_shared/view";

export function ClauseTable({ writ, act }: { writ: WritView; act: ActView | null }) {
  const clauses = clauseTable(writ.grants);
  const cited = act?.reasons[0]?.clauseRef ?? null;
  const citedPage = act?.reasons[0]?.pageNumber ?? null;

  return (
    <div className="board__scroll">
      <table className="board clauses">
        <caption className="sr">
          The clauses of the signed instrument, with the cited clause highlighted
        </caption>
        <thead>
          <tr>
            <th scope="col">Clause</th>
            <th scope="col">Where</th>
            <th scope="col">Term</th>
          </tr>
        </thead>
        <tbody>
          {clauses.map((clause) => {
            const hit = cited === clause.ref;
            return (
              <tr key={clause.ref} data-cited={hit ? "1" : undefined}>
                <td className="clauses__ref">
                  {clause.ref}
                  {hit && <span className="clauses__flag">cited</span>}
                </td>
                <td className="clauses__where">
                  p.{clause.page}
                  {clause.lines && <span>{clause.lines}</span>}
                  {hit && citedPage !== null && citedPage !== clause.page && (
                    <span>engine cited p.{citedPage}</span>
                  )}
                </td>
                <td>
                  <span className="clauses__heading">{clause.heading}</span>
                  <p className="clauses__text">{clause.text}</p>
                  {clause.terms.length > 0 && (
                    <ul className="clauses__terms">
                      {clause.terms.map((term) => (
                        <li key={term}>{term}</li>
                      ))}
                    </ul>
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
