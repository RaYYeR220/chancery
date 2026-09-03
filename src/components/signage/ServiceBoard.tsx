"use client";

/**
 * What is actually answering, seam by seam.
 *
 * A service with no credentials reads `scripted` or `unavailable`, never
 * `good service`. The demo is worth nothing if a viewer cannot tell which half
 * of it touched a network, so the board names the environment variables that
 * would move each row to live rather than leaving the gap implicit.
 */

import type { ModeReport } from "@/app/_shared/view";

const WORD: Record<string, string> = {
  live: "Good service",
  scripted: "In process",
  unavailable: "No service",
};

export function ServiceBoard({ mode }: { mode: ModeReport }) {
  return (
    <div className="services">
      <div className="services__head">
        <p className="services__headline">{mode.headline}</p>
        <p className="services__sub">
          {mode.scriptedThroughout
            ? "Nothing here needs a key. The gatekeeper and public DNS are real; every vendor seam is answered in process and says so."
            : "Some seams are configured. Each row below says what answered it, not what could have."}
        </p>
      </div>
      <ul className="services__list">
        {mode.services.map((service) => (
          <li key={service.key} data-supply={service.supply}>
            <span className="services__bar" aria-hidden="true" />
            <span className="services__name">
              {service.label}
              <span className="services__role">{service.role}</span>
            </span>
            <span className="services__state">{WORD[service.supply]}</span>
            <span className="services__detail">
              {service.detail}
              {service.supply !== "live" && service.requires.length > 0 && (
                <span className="services__requires mono">{service.requires.join(" · ")}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
