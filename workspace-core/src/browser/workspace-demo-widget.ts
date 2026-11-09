import { Widget } from '@lumino/widgets';

/** Temporary visual widget for proving the blank canvas and docking behavior. */
export class WorkspaceDemoWidget extends Widget {
    constructor(id: string, title: string, description: string, sample: string) {
        super();
        this.id = id;
        this.title.label = title;
        this.title.caption = title;
        this.title.closable = true;

        this.node.classList.add('bruce-workspace-demo-widget');
        Object.assign(this.node.style, {
            boxSizing: 'border-box',
            height: '100%',
            width: '100%',
            overflow: 'auto',
            padding: '24px',
            color: 'var(--theia-ui-foreground)',
            background: 'var(--theia-editor-background)'
        });

        const eyebrow = document.createElement('div');
        eyebrow.textContent = 'BRUCE WORKSPACE  /  DOCKING TEST';
        Object.assign(eyebrow.style, {
            fontSize: '11px',
            fontWeight: '600',
            letterSpacing: '0.12em',
            opacity: '0.65'
        });

        const heading = document.createElement('h2');
        heading.textContent = title;
        heading.style.margin = '12px 0 8px';

        const body = document.createElement('p');
        body.textContent = description;
        Object.assign(body.style, { maxWidth: '560px', lineHeight: '1.55', opacity: '0.8' });

        const content = document.createElement('pre');
        content.textContent = sample;
        Object.assign(content.style, {
            marginTop: '24px',
            padding: '16px',
            borderRadius: '8px',
            background: 'var(--theia-sideBar-background)',
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--theia-code-font-family)'
        });

        this.node.append(eyebrow, heading, body, content);
    }
}
