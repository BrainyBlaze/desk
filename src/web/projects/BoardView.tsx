import { useState, type DragEvent, type MouseEvent } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import { CircleDot, GitMerge, GitPullRequest, NotebookPen, Plus } from 'lucide-react';
import { IconButton, Pill, TextReveal } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import { LIST_REVEAL, LIST_ROW_DURATION } from '../arwes/motion.js';
import type { ProjectItem } from './projectsClient.js';
import { optionColor, type BoardColumn } from './projectsModel.js';

export interface BoardViewProps {
  columns: BoardColumn[];
  activeItemId: string | null;
  onSelectItem: (item: ProjectItem) => void;
  onItemMenu: (event: MouseEvent, item: ProjectItem) => void;
  /** drop on a column body: move item into that column */
  onMoveToColumn: (item: ProjectItem, column: BoardColumn) => void;
  /** drop on a card: reorder after that card (same column) or move+order */
  onDropOnCard: (item: ProjectItem, column: BoardColumn, after: ProjectItem) => void;
  onAddToColumn: (column: BoardColumn) => void;
}

export function itemIcon(item: ProjectItem): JSX.Element {
  if (item.type === 'PULL_REQUEST') {
    const state = item.content?.state;
    if (state === 'MERGED') {
      return <GitMerge size={12} className="prMerged" />;
    }
    return <GitPullRequest size={12} className={state === 'CLOSED' ? 'stateClosed' : 'stateOpen'} />;
  }
  if (item.type === 'DRAFT_ISSUE') {
    return <NotebookPen size={12} className="stateDraft" />;
  }
  const closed = item.content?.state === 'CLOSED';
  return <CircleDot size={12} className={closed ? 'statePurple' : 'stateOpen'} />;
}

export function BoardView({
  columns,
  activeItemId,
  onSelectItem,
  onItemMenu,
  onMoveToColumn,
  onDropOnCard,
  onAddToColumn
}: BoardViewProps): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [dragging, setDragging] = useState<ProjectItem | null>(null);
  const [dropColumn, setDropColumn] = useState<string | null>(null);

  const allowDrop = (event: DragEvent): void => {
    if (dragging) {
      event.preventDefault();
    }
  };

  return (
    <div className="projBoard">
      <Animator combine manager="stagger" duration={{ stagger: 0.05, limit: 8 }}>
        {columns.map((column) => (
          <Animator key={column.key}>
            <Animated
              className={`projColumn ${dropColumn === column.key ? 'dropTarget' : ''}`}
              animated={['fade', ['y', 12, 0]]}
              onDragOver={(event: DragEvent) => {
                allowDrop(event);
                setDropColumn(column.key);
              }}
              onDragLeave={() => setDropColumn((current) => (current === column.key ? null : current))}
              onDrop={(event: DragEvent) => {
                event.preventDefault();
                setDropColumn(null);
                if (dragging) {
                  bleeps.deploy?.play();
                  onMoveToColumn(dragging, column);
                  setDragging(null);
                }
              }}
            >
              <div className="projColumnHeader">
                <i className="projColumnDot" style={{ background: optionColor(column.color) }} />
                <TextReveal as="span" manager="decipher">{column.label}</TextReveal>
                <Pill tone={column.items.length === 0 ? 'muted' : undefined}>{column.items.length}</Pill>
                <span className="gitRowActions">
                  <IconButton icon={<Plus size={11} />} label={`Add item to ${column.label}`} onClick={() => onAddToColumn(column)} />
                </span>
              </div>
              <div className="projColumnBody">
                <Animator combine manager="stagger" duration={{ stagger: LIST_REVEAL.stagger, limit: LIST_REVEAL.limit }}>
                  {column.items.map((item) => (
                    <Animator key={item.id} duration={LIST_ROW_DURATION}>
                      <Animated
                        as="article"
                        className={`projCard ${item.id === activeItemId ? 'selected' : ''} ${dragging?.id === item.id ? 'dragging' : ''}`}
                        animated={['flicker', ['y', 8, 0]]}
                        draggable
                        title={item.content?.title}
                        onDragStart={() => setDragging(item)}
                        onDragEnd={() => {
                          setDragging(null);
                          setDropColumn(null);
                        }}
                        onDragOver={allowDrop}
                        onDrop={(event: DragEvent) => {
                          // card-level drop reorders after this card
                          event.preventDefault();
                          event.stopPropagation();
                          setDropColumn(null);
                          if (dragging && dragging.id !== item.id) {
                            bleeps.deploy?.play();
                            onDropOnCard(dragging, column, item);
                            setDragging(null);
                          }
                        }}
                        onMouseEnter={() => bleeps.hover?.play()}
                        onClick={() => {
                          bleeps.click?.play();
                          onSelectItem(item);
                        }}
                        onContextMenu={(event: MouseEvent) => onItemMenu(event, item)}
                      >
                        <header className="projCardTop">
                          {itemIcon(item)}
                          <small>
                            {item.content?.repository
                              ? `${item.content.repository.nameWithOwner.split('/')[1]}#${item.content.number}`
                              : 'draft'}
                          </small>
                          {item.isArchived ? <Pill tone="muted">archived</Pill> : null}
                        </header>
                        <span className="projCardTitle">{item.content?.title ?? '(untitled)'}</span>
                        {(item.content?.labels?.nodes.length ?? 0) > 0 ? (
                          <span className="projCardLabels">
                            {item.content!.labels!.nodes.slice(0, 4).map((label) => (
                              <i key={label.name} className="projLabelChip" style={{ borderColor: `#${label.color}`, color: `#${label.color}` }}>
                                {label.name}
                              </i>
                            ))}
                          </span>
                        ) : null}
                        {(item.content?.assignees?.nodes.length ?? 0) > 0 ? (
                          <footer className="projCardAssignees">
                            {item.content!.assignees!.nodes.map((user) => (
                              <small key={user.login}>@{user.login}</small>
                            ))}
                          </footer>
                        ) : null}
                      </Animated>
                    </Animator>
                  ))}
                </Animator>
              </div>
            </Animated>
          </Animator>
        ))}
      </Animator>
    </div>
  );
}
