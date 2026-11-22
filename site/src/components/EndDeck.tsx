import Deck from './deck/Deck';

export default function EndDeck() {
  return (
    <div data-theme="dark" className="nd-enddeck">
      <Deck screen={3} pager={false} />
    </div>
  );
}
