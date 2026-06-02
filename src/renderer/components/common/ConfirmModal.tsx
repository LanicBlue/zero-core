export function ConfirmModal({ title, message, confirmLabel, onConfirm, onCancel }: {
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="modal-overlay">
			<div className="modal-content modal-confirm" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<h3>{title}</h3>
				</div>
				<div className="modal-body">
					<p className="modal-info">{message}</p>
					<div className="modal-actions">
						<button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
						<button type="button" className="btn-danger" onClick={onConfirm}>{confirmLabel}</button>
					</div>
				</div>
			</div>
		</div>
	);
}
