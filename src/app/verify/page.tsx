import { VerifyScreen } from "@/components/verify/VerifyScreen";

export const metadata = {
  title: "Verifier — Chancery",
  description:
    "Resolve any agent's authority from public DNS. No account, no login: the raw TXT record, the DNSSEC status, the document hash and a plain-English reading.",
};

export default function VerifyPage() {
  return <VerifyScreen />;
}
