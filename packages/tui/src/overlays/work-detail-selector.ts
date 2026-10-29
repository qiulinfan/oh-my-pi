import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet } from "../native/picker";
import { WORK_DETAIL_INFO, WORK_DETAILS, type WorkDetail } from "../chat/work-detail";

/** Picker for the session's work-detail mode (compact, standard, verbose); the composer's work-detail chip opens it. */
export class WorkDetailSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#sheet: SelectListSheet;

	constructor(current: WorkDetail, onSelect: (mode: WorkDetail) => void, onCancel: () => void) {
		super("Work Details", "omp.overlay.work-detail");

		const items: SelectItem[] = WORK_DETAILS.map(mode => ({
			value: mode,
			label: mode,
			description: WORK_DETAIL_INFO[mode].detail,
		}));
		this.#selectList = new SelectList(items, items.length, getSelectListTheme());
		this.#selectList.setSelectedIndex(WORK_DETAILS.indexOf(current));
		this.#selectList.onSelect = item => onSelect(item.value as WorkDetail);
		this.#selectList.onCancel = onCancel;

		this.addChild(this.#selectList);
		this.#sheet = new SelectListSheet(this.#selectList, {
			title: "Work details",
			subtitle: "How much of its thinking and tool work this session shows",
			icon: "sliders",
			noun: "modes",
			current: [current],
			decorate: item => {
				const info = WORK_DETAIL_INFO[item.value as WorkDetail];
				return { label: info.label, detail: info.detail };
			},
		});
	}

	override describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("picker") ? this.#sheet.describe() : super.describe(cx);
	}

	/** Picker pointer events drive the list exactly as its keys do. */
	handleNativeEvent(event: NativeUiEvent): void {
		this.#sheet.handle(event);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
