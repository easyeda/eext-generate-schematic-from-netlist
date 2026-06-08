/**
 * 网表重建原理图扩展
 *
 * 功能：导入网表文件（支持.json和.enet格式），自动解析并重建原理图布局
 * 作者：嘉立创EDA扩展开发
 */
import * as extensionConfig from '../extension.json';

// 网表数据接口定义
interface NetlistComponent {
	props: {
		Designator: string;
		device_name: string;
		DeviceName?: string;
		value: string;
		'Supplier Part': string;
	};
	pins?: Record<string, string>;
	pinInfoMap?: Record<string, { name: string; number: string; net: string }>;
}

interface NetlistData {
	[key: string]: NetlistComponent;
}

// 器件布局信息
interface ComponentLayout {
	primitiveId: string;
	componentId: string; // 添加组件标识符
	x: number;
	y: number;
	width: number;
	height: number;
	pins: any[];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {}

/**
 * 导入网表文件主函数
 */
export async function importNetlist(): Promise<void> {
	try {
		// 打开文件选择对话框
		const fileContent = await selectAndReadNetlistFile();
		if (!fileContent) {
			return;
		}

		// 解析网表数据
		const netlistData = parseNetlistData(fileContent);
		if (!netlistData) {
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('Netlist file format error, please check the file format'), 'error');
			return;
		}

		// 显示确认对话框
		const componentCount = Object.keys(netlistData).length;
		const confirmed = await new Promise<boolean>((resolve) => {
			eda.sys_Dialog.showConfirmationMessage(
				eda.sys_I18n.text('Detected ${1} components, start rebuilding schematic?', undefined, undefined, componentCount),
				eda.sys_I18n.text('Confirm Import'),
				eda.sys_I18n.text('Confirm'),
				eda.sys_I18n.text('Cancel'),
				(mainButtonClicked: boolean) => {
					resolve(mainButtonClicked);
				},
			);
		});

		if (confirmed) {
			await rebuildSchematic(netlistData);
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('Schematic rebuild completed!'), 'success');
		}
	} catch (error) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('Import failed: ${1}', undefined, undefined, error), 'error');
	}
}

/**
 * 选择并读取网表文件
 */
async function selectAndReadNetlistFile(): Promise<string | null> {
	try {
		const file = await eda.sys_FileSystem.openReadFileDialog(['json', 'enet']);

		if (!file) {
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('No file selected'), 'info');
			return null;
		}

		// 使用标准的 File 对象 text() 方法读取文件内容
		if (typeof file.text === 'function') {
			return await file.text();
		}

		// 备选方案：使用 FileReader
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = (e) => {
				const result = e.target?.result as string;
				resolve(result || null);
			};
			reader.onerror = () => {
				reject(new Error(eda.sys_I18n.text('File read failed')));
			};
			reader.readAsText(file);
		});
	} catch (error) {
		console.error('File selection failed:', error);
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('File selection failed: ${1}', undefined, undefined, error), 'error');
		return null;
	}
}

/**
 * 解析网表数据
 */
function parseNetlistData(fileContent: string): NetlistData | null {
	try {
		const data = JSON.parse(fileContent);
		if (typeof data !== 'object' || data === null) {
			return null;
		}

		// 检测 .enet 格式（包含顶层 version 和 components 键）
		if (data.components && typeof data.components === 'object') {
			const components: NetlistData = {};
			for (const [id, comp] of Object.entries(data.components)) {
				const c = comp as any;
				// 标准化 pins: 将 pinInfoMap 转换为 pins 格式 { pinNumber: netName }
				if (c.pinInfoMap && !c.pins) {
					const pins: Record<string, string> = {};
					for (const [pinNum, pinInfo] of Object.entries(c.pinInfoMap)) {
						pins[pinNum] = (pinInfo as any).net || '';
					}
					c.pins = pins;
				}
				// 标准化 device_name: .enet 格式使用 DeviceName (PascalCase)
				if (c.props && !c.props.device_name && c.props.DeviceName) {
					c.props.device_name = c.props.DeviceName;
				}
				components[id] = c as NetlistComponent;
			}
			return components;
		}

		return data as NetlistData;
	} catch (error) {
		console.error('File parsing failed:', error);
		return null;
	}
}

/**
 * 重建原理图
 */
async function rebuildSchematic(netlistData: NetlistData): Promise<void> {
	const components: ComponentLayout[] = [];
	const notFoundComponents: string[] = []; // 跟踪未找到的器件
	const gridSize = 100; // 网格大小
	let currentX = 20;
	let currentY = 20;
	const maxComponentsPerRow = 15; // 每行最大器件数
	let componentCount = 0;

	// 获取系统库UUID
	const libUuid = await eda.lib_LibrariesList.getSystemLibraryUuid();

	// 检查libUuid是否有效
	if (!libUuid) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('Unable to get system library UUID'), 'error');
		return;
	}

	// 遍历所有器件
	for (const [componentId, component] of Object.entries(netlistData)) {
		try {
			// 放置器件
			const layoutInfo = await placeComponent(component, currentX, currentY, libUuid, componentId);
			if (layoutInfo) {
				components.push(layoutInfo);
				eda.sys_Log.add(
					eda.sys_I18n.text(
						'Component placement progress: ${1}/${2}',
						undefined,
						undefined,
						components.length,
						Object.keys(netlistData).length,
					),
				);

				// 立即为当前器件创建网络标签
				await createNetWiresForSingleComponent(layoutInfo, netlistData);
			} else {
				// 记录未找到的器件
				notFoundComponents.push(component.props.Designator);
				eda.sys_Log.add(eda.sys_I18n.text('Component placement failed, skipped: ${1}', undefined, undefined, component.props.Designator));
			}

			// 计算下一个器件位置
			componentCount++;
			if (componentCount % maxComponentsPerRow === 0) {
				// 换行
				currentX = 20;
				currentY += gridSize * 2;
			} else {
				// 同行下一个位置
				currentX += gridSize * 3;
			}
		} catch (error) {
			const errorMsg = eda.sys_I18n.text('Error placing component ${1}: ${2}', undefined, undefined, component.props.Designator, error);
			eda.sys_Log.add(errorMsg);
			eda.sys_Message.showToastMessage(errorMsg, 'error');
			console.error(errorMsg);
			// 异常情况也记录为未找到
			notFoundComponents.push(component.props.Designator);
		}
	}

	// 显示重建结果提示
	const totalComponents = Object.keys(netlistData).length;
	const successComponents = components.length;
	const failedComponents = notFoundComponents.length;

	eda.sys_Log.add(
		eda.sys_I18n.text(
			'Schematic rebuild complete - Total: ${1}, Success: ${2}, Failed: ${3}',
			undefined,
			undefined,
			totalComponents,
			successComponents,
			failedComponents,
		),
	);

	if (failedComponents > 0) {
		const message = eda.sys_I18n.text(
			'Rebuild complete! Placed ${1}/${2} components.\nMissing: ${3}',
			undefined,
			undefined,
			successComponents,
			totalComponents,
			notFoundComponents.join(', '),
		);
		eda.sys_Log.add(eda.sys_I18n.text('Missing components: ${1}', undefined, undefined, notFoundComponents.join(', ')));
		eda.sys_Message.showToastMessage(message, 'warning');
	} else {
		const message = eda.sys_I18n.text('Rebuild complete! All ${1} components placed.', undefined, undefined, successComponents);
		eda.sys_Log.add(message);
		eda.sys_Message.showToastMessage(message, 'success');
	}
}

/**
 * 查找器件信息
 */
async function findDeviceInfo(component: NetlistComponent): Promise<any> {
	// 尝试通过供应商料号查找器件
	if (component.props['Supplier Part']) {
		eda.sys_Log.add(eda.sys_I18n.text('Searching by supplier part: ${1}', undefined, undefined, component.props['Supplier Part']));
		const devices = await eda.lib_Device.getByLcscIds(component.props['Supplier Part']);
		if (devices && Array.isArray(devices) && devices.length > 0) {
			eda.sys_Log.add(
				eda.sys_I18n.text('Found by supplier part: ${1} - ${2}', undefined, undefined, component.props.Designator, devices[0].name),
			);
			return devices[0];
		} else {
			eda.sys_Log.add(eda.sys_I18n.text('Supplier part not found: ${1}', undefined, undefined, component.props['Supplier Part']));
		}
	}

	// 如果找不到器件，尝试通过器件名称查找
	if (component.props.device_name) {
		eda.sys_Log.add(eda.sys_I18n.text('Searching by device name: ${1}', undefined, undefined, component.props.device_name));
		const devices = await eda.lib_Device.search(component.props.device_name, '1');
		if (devices && Array.isArray(devices) && devices.length > 0) {
			eda.sys_Log.add(
				eda.sys_I18n.text('Found by device name: ${1} - ${2}', undefined, undefined, component.props.Designator, devices[0].name),
			);
			return devices[0];
		} else {
			eda.sys_Log.add(eda.sys_I18n.text('Device name not found: ${1}', undefined, undefined, component.props.device_name));
		}
	}

	eda.sys_Log.add(
		eda.sys_I18n.text(
			'Component search failed: ${1} - Supplier Part: ${2}, Device Name: ${3}',
			undefined,
			undefined,
			component.props.Designator,
			component.props['Supplier Part'] || '-',
			component.props.device_name || '-',
		),
	);
	return null;
}

/**
 * 修改器件属性
 */
async function modifyComponentProperties(primitiveId: string, component: NetlistComponent): Promise<void> {
	const modifyProps: any = {};
	if (component.props.Designator && component.props.Designator.trim() !== '') {
		modifyProps.designator = component.props.Designator;
	}
	if (component.props.value && component.props.value.trim() !== '') {
		modifyProps.name = component.props.value;
	}

	if (Object.keys(modifyProps).length > 0) {
		try {
			await eda.sch_PrimitiveComponent.modify(primitiveId, modifyProps);
			console.log(`Modified component props: ${component.props.Designator}`, modifyProps);
		} catch (error) {
			console.error(`Failed to modify component props: ${component.props.Designator}`, error);
		}
	}
}

/**
 * 计算器件尺寸
 */
function calculateComponentSize(pins: any[], x: number, y: number): { width: number; height: number } {
	let minX = x;
	let maxX = x;
	let minY = y;
	let maxY = y;
	if (pins && pins.length > 0) {
		for (const pin of pins) {
			minX = Math.min(minX, (pin as any).x);
			maxX = Math.max(maxX, (pin as any).x);
			minY = Math.min(minY, (pin as any).y);
			maxY = Math.max(maxY, (pin as any).y);
		}
	}
	return { width: maxX - minX, height: maxY - minY };
}

/**
 * 放置单个器件
 */
async function placeComponent(
	component: NetlistComponent,
	x: number,
	y: number,
	libUuid: string,
	componentId: string,
): Promise<ComponentLayout | null> {
	try {
		eda.sys_Log.add(eda.sys_I18n.text('Placing component: ${1} at (${2}, ${3})', undefined, undefined, component.props.Designator, x, y));

		const deviceInfo = await findDeviceInfo(component);
		if (!deviceInfo) {
			const errorMsg = eda.sys_I18n.text('Component not found in system library: ${1}', undefined, undefined, component.props.Designator);
			eda.sys_Log.add(errorMsg);
			eda.sys_Message.showToastMessage(errorMsg);
			return null;
		}

		// 创建器件实例
		const primitiveComponent = await eda.sch_PrimitiveComponent.create({ libraryUuid: libUuid, uuid: deviceInfo.uuid }, x, y);

		if (!primitiveComponent) {
			const errorMsg = eda.sys_I18n.text('Component creation failed: ${1}', undefined, undefined, component.props.Designator);
			eda.sys_Log.add(errorMsg);
			eda.sys_Message.showToastMessage(errorMsg);
			return null;
		}

		const primitiveId = (primitiveComponent as any).primitiveId;
		await modifyComponentProperties(primitiveId, component);

		// 获取器件引脚信息
		const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
		const { width, height } = calculateComponentSize(pins, x, y);

		eda.sys_Log.add(eda.sys_I18n.text('Component placed: ${1} - ${2}', undefined, undefined, component.props.Designator, deviceInfo.name));

		return {
			primitiveId,
			componentId,
			x,
			y,
			width,
			height,
			pins: pins || [],
		};
	} catch (error) {
		const errorMsg = eda.sys_I18n.text('Error placing component ${1}: ${2}', undefined, undefined, component.props.Designator, error);
		eda.sys_Log.add(errorMsg);
		eda.sys_Message.showToastMessage(errorMsg, 'error');
		console.error(errorMsg);
		return null;
	}
}

/**
 * 为单个器件创建网络导线
 */
async function createNetWiresForSingleComponent(component: ComponentLayout, netlistData: NetlistData): Promise<void> {
	// 根据 componentId 查找对应的网表数据
	const componentData = netlistData[component.componentId];
	if (!componentData) {
		console.warn(`Netlist data not found for component ${component.componentId}`);
		return;
	}

	// 获取器件的实际引脚信息
	const actualPins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(component.primitiveId);

	// 遍历器件的所有引脚，为每个引脚创建网络标签
	for (const [pinNumber, netName] of Object.entries(componentData.pins)) {
		// 根据引脚号查找对应的实际引脚
		if (actualPins) {
			const actualPin = actualPins.find((pin) => (pin as any).pinNumber === pinNumber);
			if (actualPin) {
				try {
					// 使用实际引脚信息
					const pin = actualPin;

					// 计算导线的起点和终点坐标
					const wireLength = 30; // 导线长度
					// 引脚坐标已经是绝对坐标
					const pinX = (pin as any).x;
					const pinY = (pin as any).y;

					// 起点始终在引脚位置
					let startX = pinX;
					let startY = pinY;
					let endX = pinX;
					let endY = pinY;

					// 根据实际引脚坐标计算器件中心
					let pinMinX = Infinity;
					let pinMaxX = -Infinity;
					for (const p of actualPins) {
						pinMinX = Math.min(pinMinX, (p as any).x);
						pinMaxX = Math.max(pinMaxX, (p as any).x);
					}
					const componentCenter = (pinMinX + pinMaxX) / 2;

					// 根据引脚位置判断导线方向
					if (pinX >= componentCenter) {
						// 引脚在组件右侧，导线向右延伸
						endX = pinX + wireLength;
					} else {
						// 引脚在组件左侧，导线向左延伸
						endX = pinX - wireLength;
					}

					// 创建带网络标签的导线
					const upperNetName = netName.toUpperCase();
					await eda.sch_PrimitiveWire.create([startX, startY, endX, endY], upperNetName);
					eda.sys_Log.add(
						eda.sys_I18n.text('Created net wire: ${1} - Component: ${2}', undefined, undefined, upperNetName, component.componentId),
					);
				} catch (error) {
					const errorMsg = eda.sys_I18n.text('Failed to create net wire ${1}: ${2}', undefined, undefined, netName.toUpperCase(), error);
					eda.sys_Log.add(errorMsg);
					eda.sys_Message.showToastMessage(errorMsg);
					console.error(errorMsg);
				}
			} else {
				console.warn(`Pin ${pinNumber} not found for component ${component.componentId}`);
			}
		}
	}
}

/**
 * 为指定器件创建网络导线（保留原函数以防其他地方调用）
 */
async function createNetWiresForComponents(targetComponents: ComponentLayout[], netlistData: NetlistData): Promise<void> {
	const netGroups: Record<string, Array<{ component: ComponentLayout; netName: string; actualPin: any }>> = {};
	const componentCenters: Record<string, number> = {};

	// 收集目标器件的网络连接信息
	for (const layout of targetComponents) {
		// 根据 componentId 查找对应的网表数据
		const componentData = netlistData[layout.componentId];
		if (!componentData) {
			console.warn(`Netlist data not found for component ${layout.componentId}`);
			continue;
		}

		// 获取器件的实际引脚信息

		// 根据实际引脚坐标计算器件中心
		let pinMinX = Infinity;
		let pinMaxX = -Infinity;
		if (actualPins) {
			for (const p of actualPins) {
				pinMinX = Math.min(pinMinX, (p as any).x);
				pinMaxX = Math.max(pinMaxX, (p as any).x);
			}
		}
		componentCenters[layout.primitiveId] = (pinMinX + pinMaxX) / 2;
		const actualPins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(layout.primitiveId);

		// 遍历器件的所有引脚
		for (const [pinNumber, netName] of Object.entries(componentData.pins)) {
			if (!netGroups[netName]) {
				netGroups[netName] = [];
			}

			// 根据引脚号查找对应的实际引脚
			if (actualPins) {
				const actualPin = actualPins.find((pin) => (pin as any).pinNumber === pinNumber);
				if (actualPin) {
					netGroups[netName].push({
						component: layout,
						netName: netName,
						actualPin: actualPin,
					});
				} else {
					console.warn(`Pin ${pinNumber} not found for component ${layout.componentId}`);
				}
			}
		}
	}

	// 为每个网络创建带标签的导线
	for (const [netName, connections] of Object.entries(netGroups)) {
		for (const connection of connections) {
			if (connection.actualPin) {
				try {
					// 使用实际引脚信息
					const pin = connection.actualPin;

					// 计算导线的起点和终点坐标
					const wireLength = 30; // 导线长度
					// 引脚坐标已经是绝对坐标
					const pinX = (pin as any).x;
					const pinY = (pin as any).y;

					// 起点始终在引脚位置
					let startX = pinX;
					let startY = pinY;
					let endX = pinX;
					let endY = pinY;

					// 使用之前计算好的器件中心
					const componentCenter = componentCenters[connection.component.primitiveId];

					// 根据引脚位置判断导线方向
					if (pinX >= componentCenter) {
						// 引脚在组件右侧，导线向右延伸
						endX = pinX + wireLength;
					} else {
						// 引脚在组件左侧，导线向左延伸
						endX = pinX - wireLength;
					}

					// 创建带网络标签的导线
					const upperNetName = netName.toUpperCase();
					await eda.sch_PrimitiveWire.create([startX, startY, endX, endY], upperNetName);
					eda.sys_Log.add(
						eda.sys_I18n.text(
							'Created net wire: ${1} - Component: ${2}',
							undefined,
							undefined,
							upperNetName,
							connection.component.componentId,
						),
					);
				} catch (error) {
					const errorMsg = eda.sys_I18n.text('Failed to create net wire ${1}: ${2}', undefined, undefined, netName.toUpperCase(), error);
					eda.sys_Log.add(errorMsg);
					eda.sys_Message.showToastMessage(errorMsg);
					console.error(errorMsg);
				}
			}
		}
	}
}

/**
 * 创建网络导线（保留原函数以防其他地方调用）
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function createNetWires(components: ComponentLayout[], netlistData: NetlistData): Promise<void> {
	// 直接调用新的函数处理所有器件
	await createNetWiresForComponents(components, netlistData);
}

/**
 * 关于对话框
 */
export function about(): void {
	eda.sys_Message.showToastMessage(
		eda.sys_I18n.text(
			'Netlist Schematic Rebuild Extension v${1} - Import netlist JSON files and auto-rebuild schematics',
			undefined,
			undefined,
			extensionConfig.version,
		),
	);
}
