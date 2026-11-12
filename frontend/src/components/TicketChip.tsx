import { useTranslation } from 'react-i18next';

/** Ticket reference chip (e.g. OPS-123) on request cards, approvals and the detail drawer. */
export function TicketChip({ ticket }: { ticket?: string | null }) {
  const { t } = useTranslation();
  if (!ticket) return null;
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded border border-border bg-panel px-1 font-mono text-[0.68rem]" title={t('access.ticket')} data-ticket={ticket}>
      {ticket}
    </span>
  );
}
