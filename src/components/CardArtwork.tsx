/** A business card in a capture frame. Decorative; all instructions stay in live text. */
export function CardArtwork() {
  return (
    <svg className="card-artwork" viewBox="0 0 280 184" fill="none" aria-hidden="true">
      <path className="card-artwork-back" d="M42 20h208v128H42z" />
      <path className="card-artwork-paper" d="M26 36h208v128H26z" />
      <path className="card-artwork-accent" d="M46 56h24v24H46z" />
      <path className="card-artwork-ink" d="M84 58h80v6H84zm0 14h52v4H84zM46 106h126v4H46zm0 14h98v4H46zm0 14h114v4H46z" />
      <path className="card-artwork-frame" d="M10 58V20h38m164 0h38v38M10 142v38h38m164 0h38v-38" />
    </svg>
  )
}
