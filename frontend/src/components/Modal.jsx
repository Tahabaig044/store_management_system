// Lightweight modal fully controlled by React state - avoids mixing Bootstrap's
// own JS modal instance lifecycle with React's rendering.
export default function Modal({ show, title, onClose, children, footer, size }) {
  if (!show) return null;
  return (
    <>
      <div className="modal-backdrop fade show" />
      <div className="modal fade show d-block" tabIndex="-1" role="dialog" onClick={onClose}>
        <div
          className={`modal-dialog modal-dialog-scrollable ${size ? `modal-${size}` : ''}`}
          role="document"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">{title}</h5>
              <button type="button" className="btn-close" onClick={onClose} aria-label="Close" />
            </div>
            <div className="modal-body">{children}</div>
            {footer && <div className="modal-footer">{footer}</div>}
          </div>
        </div>
      </div>
    </>
  );
}
