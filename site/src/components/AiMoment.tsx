import { PromptKeyboard } from '@/components/ui/knowns/illustrations/prompt-keyboard';
import Deck from './deck/Deck';

export default function AiMoment({ prompts }: { prompts: string[] }) {
  return (
    <div className="nd-ai" data-theme="dark">
      <div className="nd-ai-kb">
        <PromptKeyboard prompts={prompts} color="#22d3ee" />
      </div>
      <div className="nd-ai-phone"><Deck screen={2} askNow pager={false} /></div>
    </div>
  );
}
