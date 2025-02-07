"use client";
import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
  MouseEvent,
  createContext,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  Node,
  OnConnect,
  Connection,
  MarkerType,
  NodeChange,
  EdgeChange,
  useReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CustomNode } from "./CustomNode";
import "./flow.css";
import { Link } from "@/lib/autogpt-server-api";
import { getTypeColor } from "@/lib/utils";
import { history } from "./history";
import { CustomEdge } from "./CustomEdge";
import ConnectionLine from "./ConnectionLine";
import { Control, ControlPanel } from "@/components/edit/control/ControlPanel";
import { SaveControl } from "@/components/edit/control/SaveControl";
import { BlocksControl } from "@/components/edit/control/BlocksControl";
import { IconPlay, IconRedo2, IconUndo2 } from "@/components/ui/icons";
import { startTutorial } from "./tutorial";
import useAgentGraph from "@/hooks/useAgentGraph";

// This is for the history, this is the minimum distance a block must move before it is logged
// It helps to prevent spamming the history with small movements especially when pressing on a input in a block
const MINIMUM_MOVE_BEFORE_LOG = 50;

type FlowContextType = {
  visualizeBeads: "no" | "static" | "animate";
  setIsAnyModalOpen: (isOpen: boolean) => void;
};

export const FlowContext = createContext<FlowContextType | null>(null);

const FlowEditor: React.FC<{
  flowID?: string;
  template?: boolean;
  className?: string;
}> = ({ flowID, template, className }) => {
  const { addNodes, addEdges, getNode, deleteElements, updateNode } =
    useReactFlow<CustomNode, CustomEdge>();
  const [nodeId, setNodeId] = useState<number>(1);
  const [copiedNodes, setCopiedNodes] = useState<CustomNode[]>([]);
  const [copiedEdges, setCopiedEdges] = useState<CustomEdge[]>([]);
  const [isAnyModalOpen, setIsAnyModalOpen] = useState(false);
  const [visualizeBeads, setVisualizeBeads] = useState<
    "no" | "static" | "animate"
  >("animate");
  const {
    agentName,
    setAgentName,
    agentDescription,
    setAgentDescription,
    savedAgent,
    availableNodes,
    getOutputType,
    requestSave,
    requestSaveRun,
    nodes,
    setNodes,
    edges,
    setEdges,
  } = useAgentGraph(flowID, template, visualizeBeads !== "no");

  const initialPositionRef = useRef<{
    [key: string]: { x: number; y: number };
  }>({});
  const isDragging = useRef(false);

  // State to control if tutorial has started
  const [tutorialStarted, setTutorialStarted] = useState(false);
  // State to control if blocks menu should be pinned open
  const [pinBlocksPopover, setPinBlocksPopover] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // If resetting tutorial
    if (params.get("resetTutorial") === "true") {
      localStorage.removeItem("shepherd-tour"); // Clear tutorial flag
      window.location.href = window.location.pathname; // Redirect to clear URL parameters
    } else {
      // Otherwise, start tutorial if conditions are met
      const shouldStartTutorial = !localStorage.getItem("shepherd-tour");
      if (
        shouldStartTutorial &&
        availableNodes.length > 0 &&
        !tutorialStarted
      ) {
        startTutorial(setPinBlocksPopover);
        setTutorialStarted(true);
        localStorage.setItem("shepherd-tour", "yes");
      }
    }
  }, [availableNodes, tutorialStarted]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const isUndo =
        (isMac ? event.metaKey : event.ctrlKey) && event.key === "z";
      const isRedo =
        (isMac ? event.metaKey : event.ctrlKey) &&
        (event.key === "y" || (event.shiftKey && event.key === "Z"));

      if (isUndo) {
        event.preventDefault();
        handleUndo();
      }

      if (isRedo) {
        event.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const onNodeDragStart = (_: MouseEvent, node: Node) => {
    initialPositionRef.current[node.id] = { ...node.position };
    isDragging.current = true;
  };

  const onNodeDragEnd = (_: MouseEvent, node: Node | null) => {
    if (!node) return;

    isDragging.current = false;
    const oldPosition = initialPositionRef.current[node.id];
    const newPosition = node.position;

    // Calculate the movement distance
    if (!oldPosition || !newPosition) return;

    const distanceMoved = Math.sqrt(
      Math.pow(newPosition.x - oldPosition.x, 2) +
        Math.pow(newPosition.y - oldPosition.y, 2),
    );

    if (distanceMoved > MINIMUM_MOVE_BEFORE_LOG) {
      // Minimum movement threshold
      history.push({
        type: "UPDATE_NODE_POSITION",
        payload: { nodeId: node.id, oldPosition, newPosition },
        undo: () => updateNode(node.id, { position: oldPosition }),
        redo: () => updateNode(node.id, { position: newPosition }),
      });
    }
    delete initialPositionRef.current[node.id];
  };

  // Function to clear status, output, and close the output info dropdown of all nodes
  // and reset data beads on edges
  const clearNodesStatusAndOutput = useCallback(() => {
    setNodes((nds) => {
      const newNodes = nds.map((node) => ({
        ...node,
        data: {
          ...node.data,
          status: undefined,
          output_data: undefined,
          isOutputOpen: false,
        },
      }));

      return newNodes;
    });
  }, [setNodes]);

  const onNodesChange = useCallback(
    (nodeChanges: NodeChange<CustomNode>[]) => {
      // Persist the changes
      setNodes((prev) => applyNodeChanges(nodeChanges, prev));

      // Remove all edges that were connected to deleted nodes
      nodeChanges
        .filter((change) => change.type == "remove")
        .forEach((deletedNode) => {
          const nodeID = deletedNode.id;

          const connectedEdges = edges.filter((edge) =>
            [edge.source, edge.target].includes(nodeID),
          );
          deleteElements({
            edges: connectedEdges.map((edge) => ({ id: edge.id })),
          });
        });
    },
    [deleteElements, setNodes],
  );

  const formatEdgeID = useCallback((conn: Link | Connection): string => {
    if ("sink_id" in conn) {
      return `${conn.source_id}_${conn.source_name}_${conn.sink_id}_${conn.sink_name}`;
    } else {
      return `${conn.source}_${conn.sourceHandle}_${conn.target}_${conn.targetHandle}`;
    }
  }, []);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const edgeColor = getTypeColor(
        getOutputType(connection.source!, connection.sourceHandle!),
      );
      const sourceNode = getNode(connection.source!);
      const newEdge: CustomEdge = {
        id: formatEdgeID(connection),
        type: "custom",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          strokeWidth: 2,
          color: edgeColor,
        },
        data: {
          edgeColor,
          sourcePos: sourceNode!.position,
          isStatic: sourceNode!.data.isOutputStatic,
        },
        ...connection,
        source: connection.source!,
        target: connection.target!,
      };

      addEdges(newEdge);
      history.push({
        type: "ADD_EDGE",
        payload: { edge: newEdge },
        undo: () => {
          deleteElements({ edges: [{ id: newEdge.id }] });
        },
        redo: () => {
          addEdges(newEdge);
        },
      });
      clearNodesStatusAndOutput(); // Clear status and output on connection change
    },
    [getNode, addEdges, history, deleteElements, clearNodesStatusAndOutput],
  );

  const onEdgesChange = useCallback(
    (edgeChanges: EdgeChange<CustomEdge>[]) => {
      // Persist the changes
      setEdges((prev) => applyEdgeChanges(edgeChanges, prev));

      // Propagate edge changes to node data
      const addedEdges = edgeChanges.filter((change) => change.type === "add"),
        replaceEdges = edgeChanges.filter(
          (change) => change.type === "replace",
        ),
        removedEdges = edgeChanges.filter((change) => change.type === "remove"),
        selectedEdges = edgeChanges.filter(
          (change) => change.type === "select",
        );

      if (addedEdges.length > 0 || removedEdges.length > 0) {
        setNodes((nds) => {
          const newNodes = nds.map((node) => ({
            ...node,
            data: {
              ...node.data,
              connections: [
                // Remove node connections for deleted edges
                ...node.data.connections.filter(
                  (conn) =>
                    !removedEdges.some(
                      (removedEdge) => removedEdge.id === conn.edge_id,
                    ),
                ),
                // Add node connections for added edges
                ...addedEdges.map((addedEdge) => ({
                  edge_id: addedEdge.item.id,
                  source: addedEdge.item.source,
                  target: addedEdge.item.target,
                  sourceHandle: addedEdge.item.sourceHandle!,
                  targetHandle: addedEdge.item.targetHandle!,
                })),
              ],
            },
          }));

          return newNodes;
        });

        if (removedEdges.length > 0) {
          clearNodesStatusAndOutput(); // Clear status and output on edge deletion
        }
      }

      if (replaceEdges.length > 0) {
        // Reset node connections for all edges
        console.warn(
          "useReactFlow().setRootEdges was used to overwrite all edges. " +
            "Use addEdges, deleteElements, or reconnectEdge for incremental changes.",
          replaceEdges,
        );
        setNodes((nds) =>
          nds.map((node) => ({
            ...node,
            data: {
              ...node.data,
              connections: [
                ...replaceEdges.map((replaceEdge) => ({
                  edge_id: replaceEdge.item.id,
                  source: replaceEdge.item.source,
                  target: replaceEdge.item.target,
                  sourceHandle: replaceEdge.item.sourceHandle!,
                  targetHandle: replaceEdge.item.targetHandle!,
                })),
              ],
            },
          })),
        );
        clearNodesStatusAndOutput();
      }
    },
    [setNodes, clearNodesStatusAndOutput],
  );

  const { x, y, zoom } = useViewport();

  const addNode = useCallback(
    (blockId: string, nodeType: string) => {
      const nodeSchema = availableNodes.find((node) => node.id === blockId);
      if (!nodeSchema) {
        console.error(`Schema not found for block ID: ${blockId}`);
        return;
      }

      // Calculate the center of the viewport considering zoom
      const viewportCenter = {
        x: (window.innerWidth / 2 - x) / zoom,
        y: (window.innerHeight / 2 - y) / zoom,
      };

      const newNode: CustomNode = {
        id: nodeId.toString(),
        type: "custom",
        position: viewportCenter, // Set the position to the calculated viewport center
        data: {
          blockType: nodeType,
          title: `${nodeType} ${nodeId}`,
          description: nodeSchema.description,
          categories: nodeSchema.categories,
          inputSchema: nodeSchema.inputSchema,
          outputSchema: nodeSchema.outputSchema,
          hardcodedValues: {},
          connections: [],
          isOutputOpen: false,
          block_id: blockId,
          isOutputStatic: nodeSchema.staticOutput,
        },
      };

      addNodes(newNode);
      setNodeId((prevId) => prevId + 1);
      clearNodesStatusAndOutput(); // Clear status and output when a new node is added

      history.push({
        type: "ADD_NODE",
        payload: { node: newNode.data },
        undo: () => deleteElements({ nodes: [{ id: newNode.id }] }),
        redo: () => addNodes(newNode),
      });
    },
    [
      nodeId,
      availableNodes,
      addNodes,
      setNodes,
      deleteElements,
      clearNodesStatusAndOutput,
      x,
      y,
      zoom,
    ],
  );

  const handleUndo = () => {
    history.undo();
  };

  const handleRedo = () => {
    history.redo();
  };

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Prevent copy/paste if any modal is open or if the focus is on an input element
      const activeElement = document.activeElement;
      const isInputField =
        activeElement?.tagName === "INPUT" ||
        activeElement?.tagName === "TEXTAREA" ||
        activeElement?.getAttribute("contenteditable") === "true";

      if (isAnyModalOpen || isInputField) return;

      if (event.ctrlKey || event.metaKey) {
        if (event.key === "c" || event.key === "C") {
          // Copy selected nodes
          const selectedNodes = nodes.filter((node) => node.selected);
          const selectedEdges = edges.filter((edge) => edge.selected);
          setCopiedNodes(selectedNodes);
          setCopiedEdges(selectedEdges);
        }
        if (event.key === "v" || event.key === "V") {
          // Paste copied nodes
          if (copiedNodes.length > 0) {
            const oldToNewNodeIDMap: Record<string, string> = {};
            const pastedNodes = copiedNodes.map((node, index) => {
              const newNodeId = (nodeId + index).toString();
              oldToNewNodeIDMap[node.id] = newNodeId;
              return {
                ...node,
                id: newNodeId,
                position: {
                  x: node.position.x + 20, // Offset pasted nodes
                  y: node.position.y + 20,
                },
                data: {
                  ...node.data,
                  status: undefined, // Reset status
                  output_data: undefined, // Clear output data
                },
              };
            });
            setNodes((existingNodes) =>
              // Deselect copied nodes
              existingNodes.map((node) => ({ ...node, selected: false })),
            );
            addNodes(pastedNodes);
            setNodeId((prevId) => prevId + copiedNodes.length);

            const pastedEdges = copiedEdges.map((edge) => {
              const newSourceId = oldToNewNodeIDMap[edge.source] ?? edge.source;
              const newTargetId = oldToNewNodeIDMap[edge.target] ?? edge.target;
              return {
                ...edge,
                id: `${newSourceId}_${edge.sourceHandle}_${newTargetId}_${edge.targetHandle}_${Date.now()}`,
                source: newSourceId,
                target: newTargetId,
              };
            });
            addEdges(pastedEdges);
          }
        }
      }
    },
    [
      isAnyModalOpen,
      nodes,
      edges,
      copiedNodes,
      setNodes,
      addNodes,
      copiedEdges,
      addEdges,
      nodeId,
    ],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);

  const onNodesDelete = useCallback(() => {
    clearNodesStatusAndOutput();
  }, [clearNodesStatusAndOutput]);

  const editorControls: Control[] = [
    {
      label: "Undo",
      icon: <IconUndo2 />,
      onClick: handleUndo,
    },
    {
      label: "Redo",
      icon: <IconRedo2 />,
      onClick: handleRedo,
    },
    {
      label: "Run",
      icon: <IconPlay />,
      onClick: requestSaveRun,
    },
  ];

  return (
    <FlowContext.Provider value={{ visualizeBeads, setIsAnyModalOpen }}>
      <div className={className}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={{ custom: CustomNode }}
          edgeTypes={{ custom: CustomEdge }}
          connectionLineComponent={ConnectionLine}
          onConnect={onConnect}
          onNodesChange={onNodesChange}
          onNodesDelete={onNodesDelete}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragEnd}
          onNodeDragStart={onNodeDragStart}
          deleteKeyCode={["Backspace", "Delete"]}
          minZoom={0.2}
          maxZoom={2}
        >
          <Controls />
          <Background />
          <ControlPanel className="absolute z-10" controls={editorControls}>
            <BlocksControl
              pinBlocksPopover={pinBlocksPopover} // Pass the state to BlocksControl
              blocks={availableNodes}
              addBlock={addNode}
            />
            <SaveControl
              agentMeta={savedAgent}
              onSave={(isTemplate) => requestSave(isTemplate ?? false)}
              onDescriptionChange={setAgentDescription}
              onNameChange={setAgentName}
            />
          </ControlPanel>
        </ReactFlow>
      </div>
    </FlowContext.Provider>
  );
};

const WrappedFlowEditor: typeof FlowEditor = (props) => (
  <ReactFlowProvider>
    <FlowEditor {...props} />
  </ReactFlowProvider>
);

export default WrappedFlowEditor;
