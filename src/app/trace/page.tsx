import { TraceScreen } from "@/components/trace/TraceScreen";

export const metadata = {
  title: "Agent trace — Chancery",
  description:
    "Everything the agent attempts. Reversible work runs freely; every irreversible act meets the gate and gets a verdict citing the clause it was decided under.",
};

export default function TracePage() {
  return <TraceScreen />;
}
