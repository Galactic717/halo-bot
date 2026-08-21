import { CloseIcon } from './Icons';

export function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal--small" role="dialog" aria-label="About Halo Bot">
        <div className="modal__body">
          <button className="icon-button modal__close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
          <h2>Halo Bot</h2>
          <p className="setting-row__desc">
            AI teammates that run on your own Windows machine. Each bot has its own box, browser, memory, skills and
            routines, works in the background, and asks before it touches anything outside its box.
          </p>
          <div className="setting-row">
            <div className="setting-row__text">Version</div>
            <span className="setting-row__desc">0.1.0</span>
          </div>
          <div className="setting-row">
            <div className="setting-row__text">Runs on</div>
            <span className="setting-row__desc">Any OpenAI-compatible model with tool calling</span>
          </div>
          <div className="setting-row">
            <div className="setting-row__text">Data</div>
            <button className="btn" onClick={() => void window.halo.openDataDir()}>Open data folder</button>
          </div>
        </div>
      </div>
    </div>
  );
}
