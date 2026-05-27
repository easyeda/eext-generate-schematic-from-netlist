/**
 * Enet 网表导入脚本
 *
 * 功能：解析 .enet 格式网表，搜索并放置器件，创建网络连接
 */

// 定义 .enet 文件结构接口
interface EnetPinInfo {
	name: string;
	number: string;
	net: string;
	props: Record<string, any>;
}

interface EnetComponentProps {
	Designator: string;
	DeviceName?: string;
	device_name?: string; // 兼容旧格式
	Value?: string;
	value?: string; // 兼容旧格式
	'Supplier Part'?: string;
	[key: string]: any;
}

interface EnetComponent {
	props: EnetComponentProps;
	pinInfoMap: Record<string, EnetPinInfo>;
}

interface EnetData {
	version: string;
	components: Record<string, EnetComponent>;
}

// 布局信息接口
interface LayoutInfo {
	primitiveId: string;
	componentId: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * 主入口：导入 .enet 文件内容并重建原理图
 */
export async function importEnetSchematic(fileContent: string): Promise<void> {
	try {
		// 1. 解析 JSON
		let enetData: EnetData | null = null;
		try {
			const parsed = JSON.parse(fileContent);
			// 简单的格式检查
			if (parsed && parsed.components) {
				enetData = parsed as EnetData;
			} else {
				// 尝试兼容扁平格式（虽然 .enet 通常是嵌套的）
				enetData = { version: '1.0', components: parsed };
			}
		} catch (e) {
			eda.sys_Message.showToastMessage('JSON 解析失败', 'error');
			return;
		}

		if (!enetData || !enetData.components) {
			eda.sys_Message.showToastMessage('无效的网表格式', 'error');
			return;
		}

		const components = enetData.components;
		const componentCount = Object.keys(components).length;

		// 2. 确认对话框
		const confirmed = await new Promise<boolean>((resolve) => {
			eda.sys_Dialog.showConfirmationMessage(`解析到 ${componentCount} 个器件，是否开始导入？`, '确认导入', '确认', '取消', (result: boolean) =>
				resolve(result),
			);
		});

		if (!confirmed) return;

		// 3. 获取系统库 UUID
		const libUuid = await eda.lib_LibrariesList.getSystemLibraryUuid();
		if (!libUuid) {
			eda.sys_Message.showToastMessage('无法获取系统库 UUID', 'error');
			return;
		}

		// 4. 遍历放置器件
		const placedComponents: LayoutInfo[] = [];
		const gridSize = 100;
		let currentX = 20;
		let currentY = 20;
		const maxComponentsPerRow = 15;
		let count = 0;

		for (const [compId, compData] of Object.entries(components)) {
			try {
				// 4.1 查找器件
				const deviceInfo = await findDevice(compData.props);
				if (!deviceInfo) {
					eda.sys_Log.add(`[警告] 未找到器件: ${compData.props.Designator}`);
					continue;
				}

				// 4.2 放置器件
				const primitive = await eda.sch_PrimitiveComponent.create({ libraryUuid: libUuid, uuid: deviceInfo.uuid }, currentX, currentY);

				if (primitive) {
					const primitiveId = (primitive as any).primitiveId;

					// 4.3 修改属性
					await updateComponentProps(primitiveId, compData.props);

					// 4.4 记录布局信息
					const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
					const size = calculateSize(pins, currentX, currentY);

					const layout: LayoutInfo = {
						primitiveId,
						componentId: compId,
						x: currentX,
						y: currentY,
						width: size.width,
						height: size.height,
					};
					placedComponents.push(layout);

					// 4.5 创建网络导线
					await createWires(layout, compData.pinInfoMap, pins);

					eda.sys_Log.add(`放置成功: ${compData.props.Designator}`);
				}
			} catch (err) {
				console.error(`处理器件 ${compData.props.Designator} 出错:`, err);
			}

			// 更新坐标
			count++;
			if (count % maxComponentsPerRow === 0) {
				currentX = 20;
				currentY += gridSize * 2;
			} else {
				currentX += gridSize * 3;
			}
		}

		eda.sys_Message.showToastMessage(`导入完成！成功放置 ${placedComponents.length}/${componentCount} 个器件`, 'success');
	} catch (error) {
		eda.sys_Message.showToastMessage(`脚本执行出错: ${error}`, 'error');
		console.error(error);
	}
}

/**
 * 查找器件逻辑
 */
async function findDevice(props: EnetComponentProps): Promise<any> {
	// 优先使用 Supplier Part
	if (props['Supplier Part']) {
		const res = await eda.lib_Device.getByLcscIds(props['Supplier Part']);
		if (res && res.length > 0) return res[0];
	}

	// 其次使用 DeviceName (或 device_name)
	const name = props.DeviceName || props.device_name;
	if (name) {
		const res = await eda.lib_Device.search(name, '1');
		if (res && res.length > 0) return res[0];
	}

	return null;
}

/**
 * 更新器件属性
 */
async function updateComponentProps(primitiveId: string, props: EnetComponentProps) {
	const modifyProps: any = {};
	if (props.Designator) modifyProps.designator = props.Designator;

	const val = props.Value || props.value;
	if (val) modifyProps.name = val;

	if (Object.keys(modifyProps).length > 0) {
		await eda.sch_PrimitiveComponent.modify(primitiveId, modifyProps);
	}
}

/**
 * 计算尺寸
 */
function calculateSize(pins: any[], x: number, y: number) {
	if (!pins || pins.length === 0) return { width: 0, height: 0 };
	let minX = x;
	let maxX = x;
	let minY = y;
	let maxY = y;
	for (const p of pins) {
		minX = Math.min(minX, p.x);
		maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y);
		maxY = Math.max(maxY, p.y);
	}
	return { width: maxX - minX, height: maxY - minY };
}

/**
 * 创建导线
 */
async function createWires(layout: LayoutInfo, pinMap: Record<string, EnetPinInfo>, actualPins: any[]) {
	if (!actualPins || !pinMap) return;

	for (const [pinKey, info] of Object.entries(pinMap)) {
		// info.number 是引脚号，info.net 是网络名
		const netName = info.net;
		if (!netName) continue;

		const pinNum = info.number || pinKey;
		const actualPin = actualPins.find((p: any) => p.pinNumber === pinNum);

		if (actualPin) {
			const wireLen = 30;
			const startX = actualPin.x;
			const startY = -actualPin.y; // Y坐标反向
			let endX = startX;
			const endY = startY;

			// 简单方向判断
			const centerX = layout.x + layout.width / 2;
			if (startX >= centerX) {
				endX += wireLen; // 向右
			} else {
				endX -= wireLen; // 向左
			}

			try {
				await eda.sch_PrimitiveWire.create([startX, startY, endX, endY], netName.toUpperCase());
			} catch (e) {
				console.error(`创建导线失败 ${netName}:`, e);
			}
		}
	}
}
