// 确认弹窗组件
//
// # 文件说明书
//
// ## 核心功能
// 通用的二次确认弹窗组件，用于危险操作前的确认提示
//
// ## 输入
// 标题、消息、确认按钮文字、确认/取消回调
//
// ## 输出
// 确认弹窗 JSX
//
// ## 定位
// src/renderer/components/common/ — 通用组件，为删除等危险操作提供确认
//
// ## 依赖
// React
//
// ## 维护规则
// 样式变更需确保可访问性（焦点管理、键盘操作）
//
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
