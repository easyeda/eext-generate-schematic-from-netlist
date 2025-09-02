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
		value: string;
		'Supplier Part': string;
	};
	pins: Record<string, string>;
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
			eda.sys_Message.showToastMessage('网表文件格式错误，请检查文件格式', 'error' as any);
			return;
		}

		// 显示确认对话框
		const componentCount = Object.keys(netlistData).length;
		const confirmed = await new Promise<boolean>((resolve) => {
			eda.sys_Dialog.showConfirmationMessage(
				`检测到 ${componentCount} 个器件，是否开始重建原理图？`,
				'确认导入',
				'确认',
				'取消',
				(mainButtonClicked: boolean) => {
					resolve(mainButtonClicked);
				},
			);
		});

		if (confirmed) {
			await rebuildSchematic(netlistData);
			eda.sys_Message.showToastMessage('原理图重建完成！', 'success' as any);
		}
	} catch (error) {
		eda.sys_Message.showToastMessage(`导入失败: ${error}`, 'error' as any);
	}
}

/**
 * 选择并读取网表文件
 */
async function selectAndReadNetlistFile(): Promise<string | null> {
	try {
		const file = await eda.sys_FileSystem.openReadFileDialog(['json', 'enet']);

		if (!file) {
			eda.sys_Message.showToastMessage('未选择文件', 'info' as any);
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
				reject(new Error('文件读取失败'));
			};
			reader.readAsText(file);
		});
	} catch (error) {
		console.error('文件选择失败:', error);
		eda.sys_Message.showToastMessage('文件选择失败: ' + error, 'error' as any);
		return null;
	}
}

/**
 * 解析网表数据
 */
function parseNetlistData(fileContent: string): NetlistData | null {
	try {
		const data = JSON.parse(fileContent);
		// 验证数据格式
		if (typeof data !== 'object' || data === null) {
			return null;
		}
		return data as NetlistData;
	} catch (error) {
		console.error('文件解析失败:', error);
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
	const maxComponentsPerRow = 4; // 每行最大器件数
	let componentCount = 0;

	// 获取系统库UUID
	const libUuid = await eda.lib_LibrariesList.getSystemLibraryUuid();

	// 检查libUuid是否有效
	if (!libUuid) {
		eda.sys_Message.showToastMessage('无法获取系统库UUID', 'error' as any);
		return;
	}

	// 遍历所有器件
	for (const [componentId, component] of Object.entries(netlistData)) {
		try {
			// 放置器件
			const layoutInfo = await placeComponent(component, currentX, currentY, libUuid, componentId);
			if (layoutInfo) {
				components.push(layoutInfo);
			} else {
				// 记录未找到的器件
				notFoundComponents.push(component.props.Designator);
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
			console.error(`放置器件 ${component.props.Designator} 失败:`, error);
			// 异常情况也记录为未找到
			notFoundComponents.push(component.props.Designator);
		}
	}

	// 创建网络导线
	await createNetWires(components, netlistData);

	// 显示重建结果提示
	const totalComponents = Object.keys(netlistData).length;
	const successComponents = components.length;
	const failedComponents = notFoundComponents.length;

	if (failedComponents > 0) {
		const message = `重建完成！成功放置 ${successComponents}/${totalComponents} 个器件。\n未找到的器件: ${notFoundComponents.join(', ')}`;
		eda.sys_Message.showToastMessage(message, 'warning' as any);
	} else {
		eda.sys_Message.showToastMessage(`重建完成！成功放置所有 ${successComponents} 个器件。`, 'success' as any);
	}
}

/**
 * 查找器件信息
 */
async function findDeviceInfo(component: NetlistComponent): Promise<any> {
	// 尝试通过供应商料号查找器件
	if (component.props['Supplier Part']) {
		const devices = await eda.lib_Device.getByLcscIds(component.props['Supplier Part']);
		if (devices && Array.isArray(devices) && devices.length > 0) {
			return devices[0];
		}
	}

	// 如果找不到器件，尝试通过器件名称查找
	if (component.props.device_name) {
		const devices = await eda.lib_Device.search(component.props.device_name, '1');
		if (devices && Array.isArray(devices) && devices.length > 0) {
			return devices[0];
		}
	}

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
			console.log(`修改器件属性: ${component.props.Designator}`, modifyProps);
		} catch (error) {
			console.error(`修改器件属性失败: ${component.props.Designator}`, error);
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
		const deviceInfo = await findDeviceInfo(component);
		if (!deviceInfo) {
			console.warn(`未找到器件: ${component.props.Designator}`);
			return null;
		}

		// 创建器件实例
		const primitiveComponent = await eda.sch_PrimitiveComponent.create({ libraryUuid: libUuid, uuid: deviceInfo.uuid }, x, y);

		if (!primitiveComponent) {
			return null;
		}

		const primitiveId = (primitiveComponent as any).primitiveId;
		await modifyComponentProperties(primitiveId, component);

		// 获取器件引脚信息
		const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
		const { width, height } = calculateComponentSize(pins, x, y);

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
		console.error('放置器件失败:', error);
		return null;
	}
}

/**
 * 创建网络导线
 */
async function createNetWires(components: ComponentLayout[], netlistData: NetlistData): Promise<void> {
	const netGroups: Record<string, Array<{ component: ComponentLayout; netName: string; actualPin: any }>> = {};

	// 收集所有网络连接信息
	for (const [componentId, componentData] of Object.entries(netlistData)) {
		// 根据 componentId 查找对应的布局组件
		const layout = components.find((c) => c.componentId === componentId);
		if (!layout) {
			console.warn(`未找到组件 ${componentId} 对应的布局信息`);
			continue;
		}

		// 获取器件的实际引脚信息
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
					console.warn(`组件 ${componentId} 未找到引脚 ${pinNumber}`);
				}
			}
		}
	}

	// 为每个网络创建带标签的导线
	for (const [netName, connections] of Object.entries(netGroups)) {
		if (connections.length < 2) continue; // 跳过只有一个连接的网络

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

					// 根据引脚位置确定导线方向
					const componentCenter = connection.component.x + connection.component.width / 2;

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
				} catch (error) {
					console.error(`创建网络导线失败 ${netName.toUpperCase()}:`, error);
				}
			}
		}
	}
}

/**
 * 关于对话框
 */
export function about(): void {
	eda.sys_Message.showToastMessage(`网表重建原理图扩展 v${extensionConfig.version} - 支持导入网表JSON文件并自动重建原理图`);
}
