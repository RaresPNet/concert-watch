/**
 * Renders a model-generated reply's markdown-ish text into HTML for the
 * conversational reply path (`src/mail/handle.ts`). Distinct from
 * `src/digest/render.ts` -- that renders a fully-structured `DigestPayload`
 * deterministically; this instead has to make sense of free text a model
 * wrote, which the system prompt (`src/mail/conversation.ts`) asks to use a
 * small, fixed markdown subset for: **bold**, blank-line-separated
 * paragraphs, `- ` bullet lists, and `|`-delimited tables for listing dates.
 * Colours match `src/digest/render.ts`'s palette so a reply and a digest
 * email look like the same product.
 */

function escapeHtml(input: string): string {
	return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Inline markdown within one line/cell: **bold** only -- the one inline construct the system prompt asks the model to use. */
function renderInline(text: string): string {
	const escaped = escapeHtml(text);
	return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?[\s:-]+\|[\s|:-]*$/;

function splitTableCells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((c) => c.trim());
}

function renderTable(lines: string[]): string {
	const header = splitTableCells(lines[0]);
	const bodyRows = lines.slice(2).map(splitTableCells);

	const headHtml = header
		.map(
			(cell) =>
				`<th align="left" style="padding:6px 12px 6px 0;font-size:12px;color:#57606a;border-bottom:1px solid #e5e7eb;font-weight:600;">${renderInline(cell)}</th>`,
		)
		.join('');

	const bodyHtml = bodyRows
		.map(
			(row) =>
				`<tr>${row
					.map(
						(cell) =>
							`<td style="padding:6px 12px 6px 0;font-size:14px;color:#1f2328;border-bottom:1px solid #e5e7eb;vertical-align:top;">${renderInline(cell)}</td>`,
					)
					.join('')}</tr>`,
		)
		.join('');

	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:10px 0;width:100%;"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

function renderBulletList(lines: string[]): string {
	const items = lines.map((l) => `<li style="margin-bottom:4px;">${renderInline(l.replace(/^\s*-\s+/, ''))}</li>`).join('');
	return `<ul style="margin:8px 0;padding-left:20px;">${items}</ul>`;
}

function renderParagraph(lines: string[]): string {
	return `<p style="margin:0 0 12px 0;">${lines.map(renderInline).join('<br>')}</p>`;
}

/**
 * Renders reply text (the model's output, following the small markdown
 * subset `buildSystemPrompt` instructs it to use) into email-safe HTML:
 * paragraphs, **bold**, `- ` bullet lists, and `|`-delimited tables.
 * Anything not matching one of those block shapes is treated as an ordinary
 * paragraph line, so plain prose (the common case) renders exactly as
 * before.
 */
export function renderReplyHtml(text: string): string {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const blocks: string[] = [];
	let paragraph: string[] = [];
	let i = 0;

	const flushParagraph = () => {
		if (paragraph.length > 0) {
			blocks.push(renderParagraph(paragraph));
			paragraph = [];
		}
	};

	while (i < lines.length) {
		const line = lines[i];

		if (line.trim() === '') {
			flushParagraph();
			i++;
			continue;
		}

		if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
			flushParagraph();
			const tableLines = [line];
			let j = i + 1;
			while (j < lines.length && TABLE_ROW.test(lines[j])) {
				tableLines.push(lines[j]);
				j++;
			}
			blocks.push(renderTable(tableLines));
			i = j;
			continue;
		}

		if (/^\s*-\s+/.test(line)) {
			flushParagraph();
			const bulletLines = [line];
			let j = i + 1;
			while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
				bulletLines.push(lines[j]);
				j++;
			}
			blocks.push(renderBulletList(bulletLines));
			i = j;
			continue;
		}

		paragraph.push(line);
		i++;
	}
	flushParagraph();

	return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2328;">${blocks.join('')}</div>`;
}
