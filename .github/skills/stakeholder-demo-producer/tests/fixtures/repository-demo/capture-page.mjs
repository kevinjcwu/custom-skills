export const capturePageScript = String.raw`async ({ op, text }) => {
	if (op === "upload") {
		const input = document.querySelector("#upload");
		const transfer = new DataTransfer();
		transfer.items.add(
			new File([text], "demo-input.txt", { type: "text/plain" }),
		);
		input.files = transfer.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((resolve) => {
			const observer = new MutationObserver(() => {
				if (
					document.querySelector("#result").textContent.startsWith("Imported ")
				) {
					observer.disconnect();
					resolve();
				}
			});
			observer.observe(document.querySelector("#result"), { childList: true });
			setTimeout(resolve, 1000);
		});
		return { text: document.querySelector("#result").textContent };
	}
	if (op === "size") return { bytes: window.fixtureCapture.size };
	if (op === "bytes")
		return {
			bytes: Array.from(
				new Uint8Array(await window.fixtureCapture.arrayBuffer()),
			),
		};
	throw new Error("unsupported fixture page operation");
}`;
