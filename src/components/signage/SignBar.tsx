"use client";

/**
 * The station sign: who you are looking at, where you can go, and the four
 * facts that change while you watch.
 *
 * The strip under the nav is not decoration. It carries the instrument, the
 * agent, what is answering, and how long the authority runs — which are the
 * four things every surface below assumes you already know.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useSession } from "@/components/state/session";
import { Roundel, type RoundelTone } from "./Roundel";

const DESTINATIONS = [
  { href: "/", label: "Console" },
  { href: "/trace", label: "Agent trace" },
  { href: "/verify", label: "Verifier" },
];

export function SignBar() {
  const pathname = usePathname();
  const { session } = useSession();

  const stage = session?.stage ?? "empty";
  const tone: RoundelTone = stage === "revoked" ? "stop" : stage === "anchored" ? "go" : "slate";

  const authority =
    stage === "revoked"
      ? "Withdrawn"
      : stage === "anchored"
        ? "In force"
        : stage === "signed"
          ? "Signed, not published"
          : stage === "drafted"
            ? "Drafted, unsigned"
            : "None granted";

  const term =
    session?.writ === null || session?.writ === undefined
      ? "No instrument"
      : session.writ.daysRemaining >= 0
        ? `${session.writ.daysRemaining} days left`
        : "Lapsed";

  const supply = session?.mode.scriptedThroughout === false ? "Mixed" : "Scripted";

  return (
    <>
      <header className="signbar">
        <div className="wrap">
          <Link className="signbar__mark" href="/">
            <Roundel size={30} tone={tone} label={`Chancery — authority ${authority.toLowerCase()}`} />
            <span className="signbar__word">Chancery</span>
          </Link>
          <nav className="signbar__nav" aria-label="Surfaces">
            {DESTINATIONS.map((destination) => (
              <Link
                key={destination.href}
                href={destination.href}
                className="signbar__dest"
                aria-current={pathname === destination.href ? "page" : undefined}
              >
                {destination.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <div className="strip">
        <div className="wrap">
          <div className="strip__cell">
            <span className="strip__k">Authority</span>
            <span className="strip__v">{authority}</span>
          </div>
          <div className="strip__cell">
            <span className="strip__k">Agent</span>
            <span className="strip__v strip__v--mono">{session?.agentDomain ?? "ops.northwind.example"}</span>
          </div>
          <div className="strip__cell">
            <span className="strip__k">Principal</span>
            <span className="strip__v">{session?.writ?.principal.legalName ?? "Northwind Coffee Ltd"}</span>
          </div>
          <div className="strip__cell">
            <span className="strip__k">Term</span>
            <span className="strip__v">{term}</span>
          </div>
          <div className="strip__cell">
            <span className="strip__k">Supply</span>
            <span className="strip__v">{supply}</span>
          </div>
        </div>
      </div>
    </>
  );
}
