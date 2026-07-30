import type { Metadata } from "next";
import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { Badge, KeyValue, PageHeader, Panel, Stat } from "@/components/ui";
import { formatSimTime, titleCase } from "@/lib/format";

export const metadata: Metadata = { title: "Economy" };

export default async function EconomyPage() {
  const [economy, inhabitants] = await Promise.all([
    worldSource.getEconomy(),
    worldSource.getInhabitants(),
  ]);

  const nameOf = (id: string) => inhabitants.find((i) => i.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`${economy.currencies.length} inhabitant-created units of account`}
        title="Economy"
        lede="The world was created without a currency. Every unit of account below was proposed by an inhabitant or an organisation. The engine records, transfers and validates them; it guarantees no social value, compels no one to accept them, and penalises no one for refusing."
      />

      <div className="panel grid grid-cols-2 divide-x divide-y divide-line-soft sm:grid-cols-4">
        <Stat label="Currencies" value={economy.currencies.length} tone="amber" />
        <Stat label="Recorded trades" value={economy.trades.length} />
        <Stat label="Contracts" value={economy.contracts.length} />
        <Stat
          label="Barter and gifts"
          value={economy.nonMonetaryTransferCount}
          sub="transfers using no unit of account"
        />
      </div>

      {economy.currencies.map((currency) => {
        const holdings = economy.ledger
          .filter((entry) => entry.currencyId === currency.id)
          .sort((a, b) => b.amount - a.amount);
        const held = holdings.reduce((total, entry) => total + entry.amount, 0);

        return (
          <Panel
            key={currency.id}
            id={currency.id}
            eyebrow={`${currency.id} · created ${formatSimTime(currency.createdAt)}`}
            title={
              <>
                {currency.name}{" "}
                <span className="mono text-amber">({currency.symbol})</span>
              </>
            }
            aside={
              <Badge tone={currency.acceptingHolderIds.length > 2 ? "alive" : "warn"}>
                {currency.acceptingHolderIds.length} accepting · {currency.refusedByIds.length}{" "}
                refusing
              </Badge>
            }
            className="scroll-mt-24"
          >
            <KeyValue
              rows={[
                {
                  key: "Issuer",
                  value:
                    currency.issuerKind === "inhabitant" ? (
                      <Link href={`/inhabitants/${currency.issuerId}`} className="text-amber hover:underline">
                        {currency.issuerName}
                      </Link>
                    ) : (
                      <Link href={`/organisations#${currency.issuerId}`} className="text-amber hover:underline">
                        {currency.issuerName}
                      </Link>
                    ),
                },
                { key: "Public description", value: currency.description },
                { key: "Supply rule", value: currency.supplyRule },
                { key: "Total issued", value: `${currency.totalIssued} ${currency.symbol}`, mono: true },
                { key: "Backing", value: currency.backing },
                { key: "Governance", value: currency.governance },
                {
                  key: "Refused by",
                  value:
                    currency.refusedByIds.length === 0
                      ? "No recorded refusal."
                      : `${currency.refusedByIds.map(nameOf).join(", ")} — refusal carries no penalty.`,
                },
              ]}
            />

            <div className="hairline px-4 py-3.5">
              <p className="eyebrow mb-2">
                Ownership ledger — {held} {currency.symbol} held across {holdings.length} holders
              </p>
              <ul className="space-y-1.5">
                {holdings.map((entry) => (
                  <li key={entry.holderId} className="flex items-center gap-3 text-sm">
                    <Link
                      href={
                        entry.holderKind === "inhabitant"
                          ? `/inhabitants/${entry.holderId}`
                          : `/organisations#${entry.holderId}`
                      }
                      className="flex-1 text-ink hover:text-amber"
                    >
                      {entry.holderName}
                    </Link>
                    <span
                      aria-hidden
                      className="h-1 rounded-full bg-amber-dim"
                      style={{ width: `${Math.round((entry.amount / (held || 1)) * 40)}%` }}
                    />
                    <span className="mono w-20 text-right text-xs text-muted">
                      {entry.amount} {currency.symbol}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
        );
      })}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel eyebrow="Exchange" title="Recorded trades and transfers">
          <ul className="divide-y divide-line-soft">
            {[...economy.trades]
              .sort((a, b) => b.simTime - a.simTime)
              .map((trade) => (
                <li key={trade.id} className="px-4 py-3">
                  <p className="mono text-[0.65rem] text-dim">
                    {trade.id} · {formatSimTime(trade.simTime)} ·{" "}
                    <Link href={`/events#${trade.eventId}`} className="hover:text-amber">
                      {trade.eventId}
                    </Link>
                  </p>
                  <p className="canonical mt-1 text-sm">{trade.description}</p>
                  <p className="mono mt-1 text-[0.65rem] text-dim">
                    consent recorded by both parties: {trade.consented ? "yes" : "no"}
                  </p>
                </li>
              ))}
          </ul>
        </Panel>

        <Panel eyebrow="Obligations" title="Contracts and jobs">
          <ul className="divide-y divide-line-soft">
            {economy.contracts.map((contract) => (
              <li key={contract.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono text-xs text-amber">{contract.id}</span>
                  <Badge>{contract.kind ? titleCase(contract.kind) : "Contract"}</Badge>
                  <Badge tone={contract.status === "breached" ? "warn" : "neutral"}>
                    {contract.status}
                  </Badge>
                  <span className="mono text-[0.65rem] text-dim">
                    agreed {formatSimTime(contract.agreedAt)}
                  </span>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{contract.terms}</p>
                <p className="mono mt-1 text-[0.65rem] text-dim">
                  parties:{" "}
                  {contract.counterpartyIds.map((cid, index) => (
                    <span key={cid}>
                      {index > 0 && ", "}
                      <Link href={`/inhabitants/${cid}`} className="hover:text-amber">
                        {contract.counterpartyNames[index] ?? cid}
                      </Link>
                    </span>
                  ))}
                </p>
              </li>
            ))}
          </ul>
          <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
            The engine records agreed terms and whether they were met. It applies no penalty for a
            breach; what follows one is for the inhabitants to decide.
          </p>
        </Panel>
      </div>
    </div>
  );
}
