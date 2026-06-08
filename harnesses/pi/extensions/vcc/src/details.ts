export interface VccCompactionDetails {
	compactor: "vcc";
	version: number;
	sections: string[];
	sourceMessageCount: number;
	previousSummaryUsed: boolean;
}
