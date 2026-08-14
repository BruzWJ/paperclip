import { useTasksListActions } from "./useTasksListActions";
import { useTasksListCore, type TasksListCoreInput } from "./useTasksListCore";
import { useTasksListDerived } from "./useTasksListDerived";
import { useTasksListNavigation } from "./useTasksListNavigation";

export function useTasksListModel(input: TasksListCoreInput) {
  const coreModel = { ...input, ...useTasksListCore(input) };
  const derivedModel = { ...coreModel, ...useTasksListDerived(coreModel) };
  const navigationModel = {
    ...derivedModel,
    ...useTasksListNavigation(derivedModel),
  };
  const model = { ...navigationModel, ...useTasksListActions(navigationModel) };
  return { values: model, actions: model };
}

export type TasksListModel = ReturnType<typeof useTasksListModel>;
