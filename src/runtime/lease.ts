export interface Lease {
	release(): void;
}

export class LeaseCounter {
	private count = 0;
	public get active(): number {
		return this.count;
	}
	public acquire(onRelease: () => void): Lease {
		this.count += 1;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.count -= 1;
				onRelease();
			},
		};
	}
}
