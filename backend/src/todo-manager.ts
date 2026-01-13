import { v4 as uuidv4 } from 'uuid';
import { Todo } from '@claudia/shared';

export class TodoManager {
    private todos: Map<string, Todo> = new Map();

    createTodo(title: string, description?: string): Todo {
        const now = new Date();
        const todo: Todo = {
            id: uuidv4(),
            title,
            description,
            completed: false,
            createdAt: now,
            updatedAt: now
        };
        this.todos.set(todo.id, todo);
        return todo;
    }

    getAllTodos(): Todo[] {
        return Array.from(this.todos.values());
    }

    getTodoById(id: string): Todo | undefined {
        return this.todos.get(id);
    }

    updateTodo(id: string, updates: Partial<Pick<Todo, 'title' | 'description' | 'completed'>>): Todo | undefined {
        const todo = this.todos.get(id);
        if (!todo) {
            return undefined;
        }

        const updatedTodo: Todo = {
            ...todo,
            ...updates,
            updatedAt: new Date()
        };

        this.todos.set(id, updatedTodo);
        return updatedTodo;
    }

    deleteTodo(id: string): boolean {
        return this.todos.delete(id);
    }
}
