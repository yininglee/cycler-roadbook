# 待确认问题

## 已确认的产品决定

- 服务全国骑友，面向个人规划与使用。
- 首版 Agent 获取地图信息，理解里程、累计爬升、环线、必经点和补给。
- 独立 Web，界面延续 AI Cycler。
- 顽鹿运动、行者、iGPSPORT 为首版的导入验收目标。

## 开发前技术验证

1. **轨迹供应与授权**：确认高德是否授权轨迹保存、GPX 下载及第三方设备使用，并验证轨迹坐标。若使用其他算路数据，验证导出许可、与底图的坐标对齐、全国骑行覆盖和跨地区算路。 [高德开放平台协议](https://lbs.amap.com/pages/terms) · [GPX 1.1 规范](https://www.topografix.com/GPX/1/1/)
2. **爬升数据**：在平路、山路和包含桥隧的路线抽样，比较参考高程与估算累计爬升。记录数据缺口以及坐标、采样间距、平滑对结果的影响，确定验收误差口径。 [Copernicus DEM 数据说明](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)
3. **全国覆盖样本**：测试城市、郊县、山地、跨市路线和港澳台的地点查询、分段连续性、环线闭合、补给候选和高程覆盖。各项覆盖以实测为准。
4. **三端 GPX 兼容**：官方资料已确认三款 App 有 GPX 路书导入路径。用本工具生成的同一份文件分别在三个 App 验证，记录系统、App 版本、代表码表型号，检查中文路线名称、轨迹连续性、起终点对齐及长路线限制。若高程随文件写入，也要记录各端如何显示。 [顽鹿运动应用说明](https://app.mi.com/details?id=com.onelap.bls.dear) · [行者帮助中心](https://hc.imxingzhe.com/hc/xing/articles/1702004975-) · [iGPSPORT iGS630S 手册](https://igp-zh.oss-cn-hangzhou.aliyuncs.com/pdf/2024/6/7b380ada5c8ea18a39105ab26d12fff3.pdf)

## 可随设计推进的决定

- 建议首版由用户手动下载和导入 GPX。登录、草稿保存位置与保留期限，待确定 Web 的发布形态后落实。
