import { FaqSection } from '@/components/ui/knowns/blocks/marketing/faq-section';

export default function Faq({ title, items }: { title: string; items: Array<{ q: string; a: string }> }) {
  return <FaqSection title={title} layout="split" contact={false} items={items.map((it, i) => ({ id: `q${i}`, question: it.q, answer: it.a, answerText: it.a }))} />;
}
